/**
 * Merge the legacy PHP/MariaDB database (u365232941_saphir_managem)
 * into the current Prisma ERP schema.
 *
 * Usage (from /server):
 *   npm run merge:legacy -- --dry-run
 *   npm run merge:legacy -- --from-sql "C:\Users\Zack\Downloads\u365232941_saphir_managem.sql"
 *   npm run merge:legacy -- --societe-id=1
 *
 * Env:
 *   DATABASE_URL          destination (already in .env)
 *   OLD_DATABASE_URL      source, default mysql://root:@localhost:3306/u365232941_saphir_managem
 *   IMPORT_SOCIETE_NAME   default "Saphir Management"
 *   IMPORT_SOCIETE_ICE    default 199000000000001
 *
 * Safe to re-run: existing imported rows are skipped (document numbers,
 * emails, barcodes, inventory numbers).
 *
 * Stock: current `stock` snapshot is written to stock_by_depot.
 * Historical BLs / BRs / returns / inventories are NOT replayed onto stock.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { encrypt } from "../src/api/utils/crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const DEFAULT_OLD_URL =
  process.env.OLD_DATABASE_URL ||
  "mysql://root:@localhost:3306/u365232941_saphir_managem";
const DEFAULT_SQL = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  "Downloads",
  "u365232941_saphir_managem.sql",
);
const IMPORT_ICE = process.env.IMPORT_SOCIETE_ICE || "199000000000001";
const IMPORT_NAME = process.env.IMPORT_SOCIETE_NAME || "Saphir Management";

const ROLE_MAP = {
  admin: "Societe_Admin",
  cashier: "Caissier",
  technicocommercial: "Commercial",
  preparator: "Preparateur",
  delivery: "Livreur",
};

const ORDER_STATUS = {
  new: "EN_COURS",
  prepared: "PREPARE",
  collected: "COLLECTE",
  shipping: "EN_ROUTE",
  delivered: "LIVRE",
  payed: "PAYE",
};

const HISTORY_STATUS = {
  ...ORDER_STATUS,
  canceled: "ANNULE",
  call: "UPDATE",
  whatsapp: "UPDATE",
  edit: "UPDATE",
  maps: "UPDATE",
};

const PAYMENT_MAP = {
  cash: "ESPECE",
  tpe: "CARTE_BANCAIRE",
  cheque: "CHEQUE",
  effect: "EFFET",
  virement: "VIREMENT",
  others: "ESPECE",
};

const TX_TYPE = {
  bondachat: { up: "INBOUND", down: "INBOUND" },
  bondeliv: { up: "OUTBOUND", down: "OUTBOUND" },
  order: { up: "OUTBOUND", down: "OUTBOUND" },
  pos: { up: "OUTBOUND", down: "OUTBOUND" },
  bonderetourclient: { up: "RETURN_IN", down: "RETURN_IN" },
  bonderetourfrs: { up: "RETURN_OUT", down: "RETURN_OUT" },
  inventaire: { up: "ADJUSTMENT", down: "ADJUSTMENT" },
  initial: { up: "ADJUSTMENT", down: "ADJUSTMENT" },
  stockadd: { up: "ADJUSTMENT", down: "ADJUSTMENT" },
  agency: { up: "TRANSFER_IN", down: "TRANSFER_OUT" },
};

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const societeArg = args.find((a) => a.startsWith("--societe-id="));
const sqlArg = args.find((a) => a.startsWith("--from-sql="));
const FROM_SQL = sqlArg
  ? sqlArg.slice("--from-sql=".length).replace(/^["']|["']$/g, "")
  : args.includes("--from-sql")
    ? DEFAULT_SQL
    : null;

const stats = {
  created: {},
  skipped: {},
  reused: {},
  warnings: [],
};
const bump = (bag, key, n = 1) => {
  bag[key] = (bag[key] || 0) + n;
};

const n = (v) => {
  if (v == null || v === "") return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const money = (v) => parseFloat(n(v).toFixed(2));
const qty = (v) => parseFloat(n(v).toFixed(3));
const trim = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
};
const sanitizePhone = (raw) => {
  if (raw == null) return null;
  const digits = String(raw).replace(/[^\d+]/g, "");
  if (digits.length < 6) return null;
  return digits.slice(0, 20);
};
const asDate = (v) => {
  if (!v) return new Date();
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};
const combineDateTime = (datePart, timePart) => {
  if (!datePart) return new Date();
  const d = asDate(datePart);
  if (!timePart) return d;
  const t = String(timePart);
  const [hh, mm, ss] = t.split(":").map((x) => parseInt(x, 10) || 0);
  d.setHours(hh, mm, ss || 0, 0);
  return d;
};
const parseJson = (raw) => {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
const docStatusForCommand = (commandStatus) => {
  if (commandStatus === "ANNULE") return "CANCELLED";
  if (commandStatus === "PAYE") return "PAID";
  if (commandStatus === "LIVRE") return "COMPLETED";
  return "CONFIRMED";
};
const isExternCarrier = (user) => {
  const blob = `${user.email || ""} ${user.fname || ""} ${user.lname || ""}`;
  return /ameex|ozon|cathedis|express/i.test(blob);
};

async function queryAll(old, sql, params) {
  const [rows] = await old.query(sql, params);
  return rows;
}

function splitSqlStatements(sql) {
  const stmts = [];
  let cur = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inStr) {
      cur += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      cur += ch;
      continue;
    }
    if (ch === ";") {
      const trimmed = cur.trim();
      if (trimmed) stmts.push(trimmed);
      cur = "";
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail) stmts.push(tail);
  return stmts.filter((s) => {
    const t = s.replace(/^--.*$/gm, "").trim();
    if (!t) return false;
    if (t.startsWith("/*")) return false;
    return true;
  });
}

async function importSqlDump(adminUrl, dbName, sqlPath) {
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`SQL dump not found: ${sqlPath}`);
  }
  console.log(`📥 Importing ${sqlPath} → ${dbName} ...`);
  const sql = fs.readFileSync(sqlPath, "utf8");
  const admin = await mysql.createConnection({
    uri: adminUrl,
    multipleStatements: true,
  });
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(
      `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await admin.query(`USE \`${dbName}\``);
    const stmts = splitSqlStatements(sql);
    let i = 0;
    for (const stmt of stmts) {
      i += 1;
      if (/^(START TRANSACTION|COMMIT|SET SQL_MODE)/i.test(stmt)) continue;
      await admin.query(stmt);
      if (i % 50 === 0) process.stdout.write(`   … ${i}/${stmts.length} statements\r`);
    }
    console.log(`   Imported ${stmts.length} SQL statements.`);
  } finally {
    await admin.end();
  }
}

async function openOldConnection() {
  const parsed = new URL(DEFAULT_OLD_URL);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const adminUrl = DEFAULT_OLD_URL.replace(/\/[^/]+$/, "/");

  let old;
  try {
    old = await mysql.createConnection({ uri: DEFAULT_OLD_URL });
  } catch (err) {
    if (!FROM_SQL && !fs.existsSync(DEFAULT_SQL)) throw err;
    old = null;
  }

  let hasOrders = false;
  if (old) {
    try {
      const tables = await queryAll(old, "SHOW TABLES LIKE 'orders'");
      if (tables.length) {
        const counts = await queryAll(old, "SELECT COUNT(*) AS c FROM orders");
        hasOrders = n(counts[0]?.c) > 0;
      }
    } catch {
      hasOrders = false;
    }
  }

  const sqlPath = FROM_SQL || (hasOrders ? null : DEFAULT_SQL);
  if (!hasOrders && sqlPath) {
    if (old) await old.end();
    await importSqlDump(adminUrl, dbName, sqlPath);
    old = await mysql.createConnection({ uri: DEFAULT_OLD_URL });
  } else if (!hasOrders) {
    throw new Error(
      `Cannot reach old database ${DEFAULT_OLD_URL} and no dump was provided.\n` +
        `Re-export the old DB with DATA, then run:\n` +
        `  npm run merge:legacy -- --from-sql "C:\\Users\\Zack\\Downloads\\u365232941_saphir_managem.sql"`,
    );
  } else {
    console.log(`🔗 Connected to old DB ${DEFAULT_OLD_URL}`);
  }
  return old;
}

async function resolveSociete(prisma) {
  if (societeArg) {
    const id = parseInt(societeArg.split("=")[1], 10);
    const societe = await prisma.societe.findUnique({ where: { id } });
    if (!societe) throw new Error(`Société ${id} not found`);
    return societe;
  }
  const existing = await prisma.societe.findFirst({
    where: { ice: IMPORT_ICE },
  });
  if (existing) return existing;
  if (DRY_RUN) {
    return { id: -1, raisonSocial: IMPORT_NAME, ice: IMPORT_ICE };
  }
  return prisma.societe.create({
    data: {
      raisonSocial: IMPORT_NAME,
      ice: IMPORT_ICE,
      address: "Importé depuis u365232941_saphir_managem",
    },
  });
}

async function resolveUnitAndCategory(prisma) {
  let unit = await prisma.unit.findFirst({
    where: { name: { in: ["Piece", "Pièce", "Unite"] } },
  });
  if (!unit) unit = await prisma.unit.findFirst();
  if (!unit && !DRY_RUN) {
    unit = await prisma.unit.create({
      data: { name: "Piece", symbol: "pc", allowsFractional: false },
    });
  }
  if (!unit) unit = { id: -1 };

  let category = await prisma.category.findFirst({
    where: { name: "Import Saphir" },
  });
  if (!category && !DRY_RUN) {
    category = await prisma.category.create({
      data: { name: "Import Saphir", visible: true },
    });
  }
  if (!category) category = { id: -1 };
  return { unit, category };
}

async function loadRoles(prisma) {
  const roles = await prisma.role.findMany();
  const byName = Object.fromEntries(roles.map((r) => [r.name, r.id]));
  return byName;
}

function extractVariantSlots(raw) {
  const obj = parseJson(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const slots = [];
  for (const [attr, values] of Object.entries(obj)) {
    if (!Array.isArray(values)) continue;
    for (const v of values) {
      const name = typeof v === "string" ? v : v?.name;
      if (name) slots.push({ attr: String(attr), name: String(name) });
    }
  }
  return slots;
}

async function main() {
  console.log(DRY_RUN ? "🧪 DRY RUN — no writes to Prisma\n" : "🚀 Legacy merge starting\n");

  const old = await openOldConnection();
  const prisma = new PrismaClient({ log: ["error"] });

  const [
    oldFamilies,
    oldProducts,
    oldPacks,
    oldPackProducts,
    oldClients,
    oldFournisseurs,
    oldAgencies,
    oldUsers,
    oldVariants,
    oldStock,
    oldOrders,
    oldOrderProducts,
    oldOrderHistory,
    oldDeliveryNotes,
    oldDnProducts,
    oldDnPacks,
    oldReceptions,
    oldReceptionItems,
    oldReturns,
    oldReturnItems,
    oldInventories,
    oldInventoryItems,
    oldTransactions,
    oldProviders,
    oldCities,
  ] = await Promise.all([
    queryAll(old, "SELECT * FROM families"),
    queryAll(old, "SELECT * FROM products"),
    queryAll(old, "SELECT * FROM packs"),
    queryAll(old, "SELECT * FROM pack_products"),
    queryAll(old, "SELECT * FROM clients"),
    queryAll(old, "SELECT * FROM fournisseurs"),
    queryAll(old, "SELECT * FROM agencies"),
    queryAll(old, "SELECT * FROM users"),
    queryAll(old, "SELECT * FROM variants"),
    queryAll(old, "SELECT * FROM stock"),
    queryAll(old, "SELECT * FROM orders"),
    queryAll(old, "SELECT * FROM order_products"),
    queryAll(old, "SELECT * FROM order_history"),
    queryAll(old, "SELECT * FROM delivery_notes"),
    queryAll(old, "SELECT * FROM delivery_note_products"),
    queryAll(old, "SELECT * FROM delivery_note_packs").catch(() => []),
    queryAll(old, "SELECT * FROM bon_reception"),
    queryAll(old, "SELECT * FROM bon_reception_items"),
    queryAll(old, "SELECT * FROM retour_client_notes"),
    queryAll(old, "SELECT * FROM retour_client_notes_products"),
    queryAll(old, "SELECT * FROM inventaire"),
    queryAll(old, "SELECT * FROM inventaire_items"),
    queryAll(old, "SELECT * FROM transactions"),
    queryAll(old, "SELECT * FROM shipping_providers"),
    queryAll(old, "SELECT * FROM cities").catch(() => []),
  ]);

  console.log("📊 Old DB counts:");
  console.table({
    families: oldFamilies.length,
    products: oldProducts.length,
    packs: oldPacks.length,
    clients: oldClients.length,
    fournisseurs: oldFournisseurs.length,
    agencies: oldAgencies.length,
    users: oldUsers.length,
    stock: oldStock.length,
    orders: oldOrders.length,
    order_products: oldOrderProducts.length,
    order_history: oldOrderHistory.length,
    delivery_notes: oldDeliveryNotes.length,
    bon_reception: oldReceptions.length,
    retours: oldReturns.length,
    inventaire: oldInventories.length,
    transactions: oldTransactions.length,
  });

  if (DRY_RUN) {
    console.log("\nDry run complete. Re-run without --dry-run to import.");
    await old.end();
    await prisma.$disconnect();
    return;
  }

  const societe = await resolveSociete(prisma);
  console.log(`🏢 Target société: ${societe.raisonSocial} (#${societe.id})`);
  const { unit, category } = await resolveUnitAndCategory(prisma);
  const roles = await loadRoles(prisma);
  if (!roles.Societe_Admin) {
    throw new Error("Run `npm run seed` first so roles/units exist.");
  }

  const familyMap = new Map();
  const articleMap = new Map();
  const packMap = new Map();
  const userMap = new Map();
  const deliveryByUser = new Map();
  const depotMap = new Map();
  const agenceMap = new Map();
  const clientMap = new Map();
  const clientByPhone = new Map();
  const clientByIce = new Map();
  const fournisseurMap = new Map();
  const orderBlMap = new Map();
  const attrMap = new Map();
  const attrValueMap = new Map();

  // ── Attributes from legacy variants lookup ──
  for (const v of oldVariants) {
    const attrName = trim(v.type, 100);
    if (!attrName) continue;
    let attr = attrMap.get(attrName);
    if (!attr) {
      attr = await prisma.attribute.upsert({
        where: { name: attrName },
        update: {},
        create: { name: attrName },
      });
      attrMap.set(attrName, attr);
    }
    const valueName = trim(v.name, 100);
    if (!valueName) continue;
    const key = `${attr.id}::${valueName}`;
    if (!attrValueMap.has(key)) {
      const existing = await prisma.attributeValue.findFirst({
        where: { attributeId: attr.id, value: valueName },
      });
      const row =
        existing ||
        (await prisma.attributeValue.create({
          data: { attributeId: attr.id, value: valueName },
        }));
      attrValueMap.set(key, row);
    }
  }

  // ── Families ──
  for (const f of oldFamilies) {
    const name = trim(f.name, 255) || `Famille ${f.reference}`;
    let family = await prisma.family.findFirst({ where: { name } });
    if (!family) {
      try {
        family = await prisma.family.create({
          data: {
            categoryId: category.id,
            name,
            TVA: 0,
            image: trim(f.image),
            visible: true,
            manageInStock: true,
          },
        });
        bump(stats.created, "families");
      } catch {
        family = await prisma.family.findFirst({
          where: { name: `${name} (Saphir)` },
        });
        if (!family) {
          family = await prisma.family.create({
            data: {
              categoryId: category.id,
              name: `${name} (Saphir)`,
              TVA: 0,
              visible: true,
              manageInStock: true,
            },
          });
          bump(stats.created, "families");
        }
      }
    } else {
      bump(stats.reused, "families");
    }
    familyMap.set(n(f.reference), family.id);
  }
  if (!familyMap.size) {
    const fallback = await prisma.family.create({
      data: {
        categoryId: category.id,
        name: "Import Saphir",
        TVA: 0,
        visible: true,
        manageInStock: true,
      },
    });
    familyMap.set(-1, fallback.id);
  }

  // ── Articles ──
  for (const p of oldProducts) {
    const familyId =
      familyMap.get(n(p.familyId)) || familyMap.values().next().value;
    const preferred = trim(p.reference_prod, 50);
    let barcode = preferred || `LEGACY-${p.reference}`;
    let article = await prisma.article.findUnique({ where: { barcode } });
    if (article && preferred && article.name !== trim(p.name, 255)) {
      const alt = `LEGACY-${p.reference}`;
      const altRow = await prisma.article.findUnique({ where: { barcode: alt } });
      if (altRow) {
        article = altRow;
      } else {
        article = null;
        barcode = alt;
      }
    }
    if (!article) {
      try {
        article = await prisma.article.create({
          data: {
            familyId,
            barcode,
            name: trim(p.name, 255) || barcode,
            image: trim(p.image),
            visible: !n(p.isHidden),
            gereEnStock: true,
            unitePrincipaleId: unit.id,
            prixAchat: money(p.boughtPrice),
            prixVente1: money(p.sellPrice),
            prixVente2: money(p.sellPriceGros) || money(p.sellPrice),
            prixVente3: 0,
            commission: 0,
            createdAt: asDate(p.createdAt),
          },
        });
        bump(stats.created, "articles");
      } catch (err) {
        article = await prisma.article.findUnique({ where: { barcode } });
        if (!article) {
          stats.warnings.push(`article ${p.reference}: ${err.message}`);
          continue;
        }
        bump(stats.reused, "articles");
      }
    } else {
      bump(stats.reused, "articles");
    }
    articleMap.set(n(p.reference), article.id);

    const slots = extractVariantSlots(p.variants);
    for (const slot of slots) {
      const vBarcode = `${barcode}-${slot.attr}-${slot.name}`.slice(0, 50);
      let variant = await prisma.articleVariant.findUnique({
        where: { barcode: vBarcode },
      });
      if (!variant) {
        variant = await prisma.articleVariant.create({
          data: {
            articleId: article.id,
            barcode: vBarcode,
            name: `${article.name} ${slot.name}`.slice(0, 255),
          },
        });
        bump(stats.created, "variants");
      }
      let attr = attrMap.get(slot.attr);
      if (!attr) {
        attr = await prisma.attribute.upsert({
          where: { name: slot.attr },
          update: {},
          create: { name: slot.attr },
        });
        attrMap.set(slot.attr, attr);
      }
      const vk = `${attr.id}::${slot.name}`;
      let av = attrValueMap.get(vk);
      if (!av) {
        av = await prisma.attributeValue.findFirst({
          where: { attributeId: attr.id, value: slot.name },
        });
        if (!av) {
          av = await prisma.attributeValue.create({
            data: { attributeId: attr.id, value: slot.name },
          });
        }
        attrValueMap.set(vk, av);
      }
      await prisma.variantAttribute.upsert({
        where: {
          variantId_attributeId: { variantId: variant.id, attributeId: attr.id },
        },
        update: { attributeValueId: av.id },
        create: {
          variantId: variant.id,
          attributeId: attr.id,
          attributeValueId: av.id,
        },
      });
    }

    await prisma.societePricing.upsert({
      where: {
        societeId_articleId: { societeId: societe.id, articleId: article.id },
      },
      update: {
        prixAchat: money(p.boughtPrice),
        prixVente1: money(p.sellPrice),
        prixVente2: money(p.sellPriceGros) || money(p.sellPrice),
        active: true,
      },
      create: {
        societeId: societe.id,
        articleId: article.id,
        prixAchat: money(p.boughtPrice),
        prixVente1: money(p.sellPrice),
        prixVente2: money(p.sellPriceGros) || money(p.sellPrice),
        active: true,
      },
    });
  }

  // ── Packs ──
  for (const p of oldPacks) {
    const barcode = trim(p.reference_prod, 50) || `PACK-LEGACY-${p.reference}`;
    let pack = await prisma.pack.findFirst({
      where: { OR: [{ barcode }, { societeId: societe.id, name: trim(p.name, 255) }] },
    });
    const components = oldPackProducts.filter(
      (c) => n(c.packReference) === n(p.reference),
    );
    let montant = 0;
    let cout = 0;
    for (const c of components) {
      const artId = articleMap.get(n(c.productReference));
      if (!artId) continue;
      const art = await prisma.article.findUnique({
        where: { id: artId },
        select: { prixAchat: true, prixVente1: true },
      });
      montant += money(art?.prixVente1) * n(c.quantity);
      cout += money(art?.prixAchat) * n(c.quantity);
    }
    const prix = money(p.price);
    if (!pack) {
      pack = await prisma.pack.create({
        data: {
          societeId: societe.id,
          barcode,
          name: trim(p.name, 255) || barcode,
          coutRevient: money(cout),
          tauxMarge: 0,
          montantVenteArticles: money(montant),
          prixVentePack: prix,
          purchasePrice: money(cout),
          commission: 0,
          active: true,
        },
      });
      bump(stats.created, "packs");
    } else {
      bump(stats.reused, "packs");
    }
    packMap.set(n(p.reference), pack.id);
    for (const c of components) {
      const artId = articleMap.get(n(c.productReference));
      if (artId == null) continue;
      await prisma.packComponent.upsert({
        where: { packId_articleId: { packId: pack.id, articleId: artId } },
        update: { quantity: qty(c.quantity) },
        create: {
          packId: pack.id,
          articleId: artId,
          quantity: qty(c.quantity),
          priceField: "prixVente1",
        },
      });
    }
  }

  // ── Users ──
  const livreurRefs = new Set(oldOrders.map((o) => n(o.livreur)));
  const prepRefs = new Set(oldOrders.map((o) => n(o.preparateur)));
  for (const u of oldUsers) {
    const email = trim(u.email, 255);
    if (!email) {
      stats.warnings.push(`user ${u.reference}: missing email`);
      continue;
    }
    const roleName = ROLE_MAP[u.role] || "Commercial";
    const roleId = roles[roleName] || roles.Commercial;
    const name =
      `${trim(u.fname) || ""} ${trim(u.lname) || ""}`.trim() ||
      email.split("@")[0];
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const rawPassword = String(u.password || "").trim() || `ChangeMe-${u.reference}`;
      const hashed = rawPassword.startsWith("$2")
        ? rawPassword
        : await bcrypt.hash(rawPassword, 10);
      user = await prisma.user.create({
        data: {
          email,
          name: name.slice(0, 191),
          password: hashed,
          roleId,
          societeId: societe.id,
          active: !n(u.banned),
          canBePreparateur:
            u.role === "preparator" || prepRefs.has(n(u.reference)),
          canBeLivreur: u.role === "delivery" || livreurRefs.has(n(u.reference)),
        },
      });
      bump(stats.created, "users");
    } else {
      bump(stats.reused, "users");
    }
    userMap.set(n(u.reference), user.id);

    if (u.role === "delivery" || livreurRefs.has(n(u.reference))) {
      let delivery = await prisma.delivery.findFirst({
        where: { userId: user.id },
      });
      if (!delivery) {
        delivery = await prisma.delivery.findFirst({
          where: { societeId: societe.id, name, tel: sanitizePhone(u.phone) },
        });
      }
      if (!delivery) {
        delivery = await prisma.delivery.create({
          data: {
            societeId: societe.id,
            userId: user.id,
            name: name.slice(0, 255),
            type: isExternCarrier(u) ? "EXTERN" : "INTERN",
            entityType: isExternCarrier(u) ? "SOCIETE" : "PARTICULIER",
            tel: sanitizePhone(u.phone),
            active: !n(u.banned),
          },
        });
        bump(stats.created, "deliveries");
      }
      deliveryByUser.set(n(u.reference), delivery.id);
    }
  }

  const fallbackUserId =
    userMap.get(1) ||
    (
      await prisma.user.findFirst({
        where: { societeId: societe.id },
        select: { id: true },
      })
    )?.id ||
    (
      await prisma.user.findFirst({
        where: { isSuperAdmin: true },
        select: { id: true },
      })
    )?.id ||
    null;

  // ── Agencies → depot + agence ──
  let firstDepotId = null;
  for (const a of oldAgencies) {
    const code = `A${a.reference}`.slice(0, 20);
    let depot = await prisma.depot.findFirst({
      where: { societeId: societe.id, code },
    });
    if (!depot) {
      depot = await prisma.depot.create({
        data: {
          societeId: societe.id,
          code,
          name: trim(a.name, 255) || code,
          address: trim(a.location),
          city: trim(a.name, 100),
          phone: sanitizePhone(a.phone),
          type: firstDepotId ? "SECONDARY" : "PRINCIPAL",
          active: true,
        },
      });
      bump(stats.created, "depots");
    }
    depotMap.set(n(a.reference), depot.id);
    if (!firstDepotId) firstDepotId = depot.id;

    let agence = await prisma.agence.findFirst({
      where: { societeId: societe.id, name: trim(a.name, 255) || code },
    });
    if (!agence) {
      agence = await prisma.agence.create({
        data: {
          societeId: societe.id,
          name: trim(a.name, 255) || code,
          localisation: trim(a.location),
          responsable: userMap.has(n(a.responsible))
            ? oldUsers.find((u) => n(u.reference) === n(a.responsible))?.fname
            : null,
          active: true,
        },
      });
      bump(stats.created, "agences");
    }
    agenceMap.set(n(a.reference), agence.id);
  }
  if (!firstDepotId) {
    const depot = await prisma.depot.create({
      data: {
        societeId: societe.id,
        code: "PRINCIPAL",
        name: "Dépôt principal",
        type: "PRINCIPAL",
        active: true,
      },
    });
    firstDepotId = depot.id;
    bump(stats.created, "depots");
  }

  // ── Formal clients ──
  for (const c of oldClients) {
    const phone = sanitizePhone(c.phone);
    const ice = trim(c.company_ice, 15);
    let client = null;
    if (phone) {
      client = await prisma.client.findFirst({
        where: { societeId: societe.id, phone },
      });
    }
    if (!client) {
      client = await prisma.client.create({
        data: {
          societeId: societe.id,
          name: trim(c.fullname, 255) || `Client ${c.reference}`,
          type: c.type === "personal" ? "PARTICULIER" : "SOCIETE",
          address: trim(c.address),
          phone,
          ice,
          rc: trim(c.company_rc, 20),
          if: trim(c.company_if, 20),
          tp: trim(c.company_tp, 20),
          active: true,
          createdAt: asDate(c.created_date),
        },
      });
      bump(stats.created, "clients");
    } else {
      bump(stats.reused, "clients");
    }
    clientMap.set(n(c.reference), client.id);
    if (phone) clientByPhone.set(phone, client.id);
    if (ice) clientByIce.set(ice, client.id);
  }

  let systemClient = await prisma.client.findFirst({
    where: { societeId: societe.id, isSystem: true },
  });
  if (!systemClient) {
    systemClient = await prisma.client.create({
      data: {
        societeId: societe.id,
        name: "Client Système (Passager)",
        type: "PARTICULIER",
        isSystem: true,
        active: true,
      },
    });
  }

  // ── Clients from orders (legacy clients table is almost empty) ──
  for (const o of oldOrders) {
    const phone = sanitizePhone(o.phone);
    if (phone && clientByPhone.has(phone)) continue;
    const name = trim(o.fullname, 255) || phone || `Client commande ${o.reference}`;
    const ice = trim(o.ice, 15);
    if (ice && clientByIce.has(ice) && !phone) continue;
    let client = null;
    if (phone) {
      client = await prisma.client.findFirst({
        where: { societeId: societe.id, phone },
      });
    }
    if (!client && ice) {
      client = await prisma.client.findFirst({
        where: { societeId: societe.id, ice },
      });
    }
    if (!client) {
      try {
        client = await prisma.client.create({
          data: {
            societeId: societe.id,
            name,
            type: n(o.is_company) ? "SOCIETE" : "PARTICULIER",
            address: trim(o.address),
            city: trim(o.city, 100),
            phone,
            ice: ice || null,
            active: true,
          },
        });
        bump(stats.created, "clients");
      } catch {
        client = phone
          ? await prisma.client.findFirst({
              where: { societeId: societe.id, phone },
            })
          : null;
        if (!client) client = systemClient;
        else bump(stats.reused, "clients");
      }
    } else {
      bump(stats.reused, "clients");
    }
    if (phone) clientByPhone.set(phone, client.id);
    if (ice) clientByIce.set(ice, client.id);
  }

  // ── Fournisseurs ──
  for (const f of oldFournisseurs) {
    const phone = sanitizePhone(f.phone);
    let frs = phone
      ? await prisma.fournisseur.findFirst({
          where: { societeId: societe.id, phone },
        })
      : null;
    if (!frs) {
      frs = await prisma.fournisseur.create({
        data: {
          societeId: societe.id,
          name: trim(f.fullname, 255) || `Fournisseur ${f.reference}`,
          type: f.type === "personal" ? "PARTICULIER" : "SOCIETE",
          address: trim(f.address),
          phone,
          ice: trim(f.company_ice, 15),
          rc: trim(f.company_rc, 20),
          if: trim(f.company_if, 20),
          tp: trim(f.company_tp, 20),
          active: true,
        },
      });
      bump(stats.created, "fournisseurs");
    } else {
      bump(stats.reused, "fournisseurs");
    }
    fournisseurMap.set(n(f.reference), frs.id);
  }

  // ── Current stock snapshot ──
  for (const s of oldStock) {
    const articleId = articleMap.get(n(s.product_id));
    const depotId = depotMap.get(n(s.agency)) || firstDepotId;
    if (articleId == null || !depotId) continue;
    await prisma.stockByDepot.upsert({
      where: { depotId_articleId: { depotId, articleId } },
      update: { quantityAvailable: qty(s.quantity) },
      create: {
        depotId,
        articleId,
        quantityAvailable: qty(s.quantity),
      },
    });
    bump(stats.created, "stock");
  }

  const linesByOrder = new Map();
  for (const line of oldOrderProducts) {
    const key = n(line.order_reference);
    if (!linesByOrder.has(key)) linesByOrder.set(key, []);
    linesByOrder.get(key).push(line);
  }
  const historyByOrder = new Map();
  for (const h of oldOrderHistory) {
    const key = n(h.order_reference);
    if (!historyByOrder.has(key)) historyByOrder.set(key, []);
    historyByOrder.get(key).push(h);
  }

  const existingDocs = await prisma.clientDocument.findMany({
    where: { societeId: societe.id },
    select: { id: true, documentNumber: true },
  });
  const existingDocByNumber = new Map(
    existingDocs.map((d) => [d.documentNumber, d.id]),
  );
  const newlyImportedOrders = new Set();

  // ── Advanced BLs from orders ──
  let orderIndex = 0;
  for (const o of oldOrders) {
    orderIndex += 1;
    const documentNumber = String(o.reference);
    const existingId = existingDocByNumber.get(documentNumber);
    if (existingId) {
      orderBlMap.set(n(o.reference), existingId);
      bump(stats.skipped, "orders");
      continue;
    }

    const phone = sanitizePhone(o.phone);
    const clientId =
      (phone && clientByPhone.get(phone)) || systemClient.id;
    const canceled = n(o.isCanceled) === 1;
    const commandStatus = canceled
      ? "ANNULE"
      : ORDER_STATUS[o.statut] || "EN_COURS";
    const status = docStatusForCommand(commandStatus);
    const documentDate = combineDateTime(o.order_date, o.order_time);
    const totalTTC = money(o.price);
    const amountPaid = commandStatus === "PAYE" ? totalTTC : 0;
    const amountDue = parseFloat((totalTTC - amountPaid).toFixed(2));
    const notes = [
      trim(o.notes),
      n(o.cout_livraison) ? `Frais livraison: ${o.cout_livraison}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const articleLines = [];
    const packLines = [];
    let lineNumber = 0;
    for (const line of linesByOrder.get(n(o.reference)) || []) {
      const isPack = line.type === "pack";
      const unitPrice = money(line.price);
      const quantity = qty(line.quantity) || 1;
      const total = money(unitPrice * quantity);
      if (isPack) {
        const packId = packMap.get(n(line.product_reference));
        if (packId == null) {
          stats.warnings.push(
            `order ${o.reference}: missing pack ${line.product_reference}`,
          );
          continue;
        }
        packLines.push({
          packId,
          quantity,
          prixVente: unitPrice,
          commission: 0,
        });
      } else {
        lineNumber += 1;
        const articleId = articleMap.get(n(line.product_reference));
        articleLines.push({
          articleId: articleId ?? null,
          variantId: null,
          lineNumber,
          description:
            (articleId &&
              oldProducts.find((p) => n(p.reference) === n(line.product_reference))
                ?.name) ||
            `Produit ${line.product_reference}`,
          quantity,
          unitPrice,
          remise: 0,
          commission: 0,
          totalHT: total,
          tvaRate: 0,
          totalTVA: 0,
          totalTTC: total,
        });
      }
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        const header = await tx.clientDocument.create({
          data: {
            societeId: societe.id,
            clientId,
            clientName: trim(o.fullname, 255),
            documentNumber,
            status,
            totalHT: totalTTC,
            totalTVA: 0,
            totalTTC,
            discount: 0,
            amountPaid,
            amountDue,
            notes: notes || null,
            createdBy: userMap.get(n(o.createdBy)) || fallbackUserId,
            createdAt: asDate(o.createdAt),
          },
        });
        await tx.bonLivraison.create({
          data: {
            id: header.id,
            documentDate,
            dateLivraison: documentDate,
            depotId: depotMap.get(n(o.agence)) || firstDepotId,
            type: "ADVANCED",
            commandStatus,
            agenceId: agenceMap.get(n(o.agence)) || null,
            heureLivraison: trim(o.order_time, 10),
            telephone: phone,
            whatsapp: sanitizePhone(o.whatsapp),
            ville: trim(o.city, 100),
            localisation: trim(o.address),
            withFacture: !!n(o.is_company),
            raisonSocial: trim(o.raisonsocial, 255),
            ice: trim(o.ice, 15),
            siegeSocial: trim(o.siegesocial, 255),
            nombreDeColis: n(o.ncolis) || null,
            observation: notes || null,
            modeReglement: PAYMENT_MAP[o.payment_method] || "ESPECE",
            commercialId: userMap.get(n(o.createdBy)) || null,
            preparateurId: userMap.get(n(o.preparateur)) || null,
            livreurId: deliveryByUser.get(n(o.livreur)) || null,
            totalCommission: money(o.comission),
            isReported: !!n(o.reported),
            createdAt: asDate(o.createdAt),
          },
        });
        if (articleLines.length) {
          await tx.clientDocumentLine.createMany({
            data: articleLines.map((l) => ({ ...l, documentId: header.id })),
          });
        }
        if (packLines.length) {
          await tx.bonLivraisonPackLine.createMany({
            data: packLines.map((l) => ({ ...l, bonLivraisonId: header.id })),
          });
        }
        return header.id;
      });
      orderBlMap.set(n(o.reference), created);
      newlyImportedOrders.add(n(o.reference));
      existingDocByNumber.set(documentNumber, created);
      bump(stats.created, "orders");
    } catch (err) {
      stats.warnings.push(`order ${o.reference}: ${err.message}`);
    }

    if (orderIndex % 100 === 0) {
      console.log(`   orders ${orderIndex}/${oldOrders.length}`);
    }
  }

  // ── Order status history ──
  const historyRows = [];
  for (const [oldRef, bonId] of orderBlMap) {
    if (!newlyImportedOrders.has(oldRef)) continue;
    const events = (historyByOrder.get(oldRef) || []).sort(
      (a, b) => asDate(a.date) - asDate(b.date),
    );
    if (!events.length) {
      const o = oldOrders.find((x) => n(x.reference) === oldRef);
      historyRows.push({
        bonId,
        status: n(o?.isCanceled)
          ? "ANNULE"
          : ORDER_STATUS[o?.statut] || "EN_COURS",
        note: "legacy import",
        userId: userMap.get(n(o?.createdBy)) || null,
        createdAt: asDate(o?.createdAt),
      });
      continue;
    }
    for (const h of events) {
      const status = HISTORY_STATUS[h.status];
      if (!status) continue;
      historyRows.push({
        bonId,
        status,
        note: ["call", "whatsapp", "edit", "maps"].includes(h.status)
          ? `legacy:${h.status}`
          : null,
        userId: userMap.get(n(h.user)) || null,
        createdAt: asDate(h.date),
      });
    }
  }
  for (let i = 0; i < historyRows.length; i += 500) {
    const chunk = historyRows.slice(i, i + 500);
    await prisma.bonLivraisonStatusHistory.createMany({
      data: chunk,
    });
    bump(stats.created, "order_history", chunk.length);
  }

  // ── Standard BLs from delivery_notes ──
  const dnLines = new Map();
  for (const l of oldDnProducts) {
    const key = n(l.delivery_note_reference);
    if (!dnLines.has(key)) dnLines.set(key, []);
    dnLines.get(key).push(l);
  }
  const dnPacks = new Map();
  for (const l of oldDnPacks || []) {
    const key = n(l.delivery_note_reference);
    if (!dnPacks.has(key)) dnPacks.set(key, []);
    dnPacks.get(key).push(l);
  }
  for (const dn of oldDeliveryNotes) {
    const documentNumber = `DN-${dn.reference}`;
    const exists = await prisma.clientDocument.findFirst({
      where: { societeId: societe.id, documentNumber },
      select: { id: true },
    });
    if (exists) {
      bump(stats.skipped, "delivery_notes");
      continue;
    }
    const clientId =
      (dn.client_reference != null &&
        clientMap.get(n(dn.client_reference))) ||
      systemClient.id;
    const lines = [];
    let lineNumber = 0;
    let totalTTC = 0;
    for (const l of dnLines.get(n(dn.reference)) || []) {
      lineNumber += 1;
      const unitPrice = money(l.price);
      const quantity = qty(l.quantity) || 1;
      const total = money(unitPrice * quantity);
      totalTTC += total;
      lines.push({
        articleId: articleMap.get(n(l.product_reference)) ?? null,
        lineNumber,
        description: `Produit ${l.product_reference}`,
        quantity,
        unitPrice,
        totalHT: total,
        tvaRate: 0,
        totalTVA: 0,
        totalTTC: total,
      });
    }
    const packLines = [];
    for (const l of dnPacks.get(n(dn.reference)) || []) {
      const packId = packMap.get(n(l.pack_reference));
      if (packId == null) continue;
      const unitPrice = money(l.price);
      const quantity = qty(l.quantity) || 1;
      totalTTC += money(unitPrice * quantity);
      packLines.push({
        packId,
        quantity,
        prixVente: unitPrice,
        commission: 0,
      });
    }
    totalTTC = money(totalTTC);
    const status = dn.status === "completed" ? "COMPLETED" : "DRAFT";
    try {
      await prisma.$transaction(async (tx) => {
        const header = await tx.clientDocument.create({
          data: {
            societeId: societe.id,
            clientId,
            documentNumber,
            status,
            totalHT: totalTTC,
            totalTVA: 0,
            totalTTC,
            amountPaid: status === "COMPLETED" ? totalTTC : 0,
            amountDue: status === "COMPLETED" ? 0 : totalTTC,
            notes: `legacy delivery_note type=${dn.type}`,
            createdBy: fallbackUserId,
            createdAt: asDate(dn.created_date),
          },
        });
        await tx.bonLivraison.create({
          data: {
            id: header.id,
            documentDate: asDate(dn.delivery_date || dn.created_date),
            dateLivraison: asDate(dn.delivery_date || dn.created_date),
            depotId: firstDepotId,
            type: "STANDARD",
          },
        });
        if (lines.length) {
          await tx.clientDocumentLine.createMany({
            data: lines.map((l) => ({ ...l, documentId: header.id })),
          });
        }
        if (packLines.length) {
          await tx.bonLivraisonPackLine.createMany({
            data: packLines.map((l) => ({ ...l, bonLivraisonId: header.id })),
          });
        }
      });
      bump(stats.created, "delivery_notes");
    } catch (err) {
      stats.warnings.push(`DN ${dn.reference}: ${err.message}`);
    }
  }

  // ── Bon réception ──
  const brItems = new Map();
  for (const it of oldReceptionItems) {
    const key = n(it.bon_reception_reference);
    if (!brItems.has(key)) brItems.set(key, []);
    brItems.get(key).push(it);
  }
  for (const br of oldReceptions) {
    const documentNumber = `BR-OLD-${br.id}`;
    const exists = await prisma.fournisseurDocument.findFirst({
      where: { societeId: societe.id, documentNumber },
    });
    if (exists) {
      bump(stats.skipped, "bon_reception");
      continue;
    }
    const fournisseurId = fournisseurMap.get(n(br.frs_reference));
    if (!fournisseurId) {
      stats.warnings.push(`BR ${br.id}: missing fournisseur`);
      continue;
    }
    const lines = [];
    let lineNumber = 0;
    let totalTTC = 0;
    for (const it of brItems.get(n(br.id)) || []) {
      if (it.type === "pack") continue;
      lineNumber += 1;
      const unitPrice = money(it.price);
      const quantity = qty(it.quantity) || 1;
      const total = money(unitPrice * quantity);
      totalTTC += total;
      lines.push({
        articleId: articleMap.get(n(it.product_reference)) ?? null,
        lineNumber,
        description: `Produit ${it.product_reference}`,
        quantity,
        unitPrice,
        totalHT: total,
        tvaRate: 0,
        totalTVA: 0,
        totalTTC: total,
      });
    }
    totalTTC = money(totalTTC);
    const status = br.status === "completed" ? "COMPLETED" : "DRAFT";
    const documentReference =
      trim(br.reference, 100) || `BR-OLD-${br.id}`;
    try {
      await prisma.$transaction(async (tx) => {
        const header = await tx.fournisseurDocument.create({
          data: {
            societeId: societe.id,
            fournisseurId,
            documentNumber,
            status,
            totalHT: totalTTC,
            totalTVA: 0,
            totalTTC,
            amountPaid: 0,
            amountDue: totalTTC,
            createdBy: fallbackUserId,
            createdAt: asDate(br.created_date),
          },
        });
        await tx.bonReception.create({
          data: {
            id: header.id,
            documentDate: asDate(br.created_date),
            dateReception: asDate(br.delivery_date),
            depotId: depotMap.get(n(br.agency_reference)) || firstDepotId,
            documentReference,
          },
        });
        if (lines.length) {
          await tx.fournisseurDocumentLine.createMany({
            data: lines.map((l) => ({ ...l, documentId: header.id })),
          });
        }
      });
      bump(stats.created, "bon_reception");
    } catch (err) {
      stats.warnings.push(`BR ${br.id}: ${err.message}`);
    }
  }

  // ── Retours client ──
  const retItems = new Map();
  for (const it of oldReturnItems) {
    const key = n(it.delivery_note_reference);
    if (!retItems.has(key)) retItems.set(key, []);
    retItems.get(key).push(it);
  }
  for (const ret of oldReturns) {
    const documentNumber = `BRC-OLD-${ret.reference}`;
    const exists = await prisma.clientDocument.findFirst({
      where: { societeId: societe.id, documentNumber },
    });
    if (exists) {
      bump(stats.skipped, "retours");
      continue;
    }
    const clientId =
      (ret.client_reference != null &&
        clientMap.get(n(ret.client_reference))) ||
      systemClient.id;
    const lines = [];
    const packLines = [];
    let lineNumber = 0;
    let totalTTC = 0;
    for (const it of retItems.get(n(ret.reference)) || []) {
      const unitPrice = money(it.price);
      const quantity = qty(it.quantity) || 1;
      const total = money(unitPrice * quantity);
      totalTTC += total;
      if (it.type === "pack") {
        const packId = packMap.get(n(it.product_reference));
        if (packId != null) {
          packLines.push({ packId, quantity, prixVente: unitPrice });
        }
      } else {
        lineNumber += 1;
        lines.push({
          articleId: articleMap.get(n(it.product_reference)) ?? null,
          lineNumber,
          description: `Produit ${it.product_reference}`,
          quantity,
          unitPrice,
          totalHT: total,
          tvaRate: 0,
          totalTVA: 0,
          totalTTC: total,
        });
      }
    }
    totalTTC = money(totalTTC);
    const status = ret.status === "completed" ? "COMPLETED" : "DRAFT";
    try {
      await prisma.$transaction(async (tx) => {
        const header = await tx.clientDocument.create({
          data: {
            societeId: societe.id,
            clientId,
            documentNumber,
            status,
            totalHT: totalTTC,
            totalTVA: 0,
            totalTTC,
            amountPaid: 0,
            amountDue: totalTTC,
            createdBy: fallbackUserId,
            createdAt: asDate(ret.created_date),
          },
        });
        await tx.bonRetourClient.create({
          data: {
            id: header.id,
            documentDate: asDate(ret.created_date),
            dateRetour: asDate(ret.delivery_date),
            depotId: firstDepotId,
            motifRetour: `legacy retour type=${ret.type}`,
          },
        });
        if (lines.length) {
          await tx.clientDocumentLine.createMany({
            data: lines.map((l) => ({ ...l, documentId: header.id })),
          });
        }
        if (packLines.length) {
          await tx.bonRetourClientPackLine.createMany({
            data: packLines.map((l) => ({
              ...l,
              bonRetourClientId: header.id,
            })),
          });
        }
      });
      bump(stats.created, "retours");
    } catch (err) {
      stats.warnings.push(`BRC ${ret.reference}: ${err.message}`);
    }
  }

  // ── Inventories ──
  const invItems = new Map();
  for (const it of oldInventoryItems) {
    const key = n(it.inventaire_id);
    if (!invItems.has(key)) invItems.set(key, []);
    invItems.get(key).push(it);
  }
  for (const inv of oldInventories) {
    const inventoryNumber = `INV-OLD-${inv.id}`;
    const exists = await prisma.inventory.findFirst({
      where: { societeId: societe.id, inventoryNumber },
    });
    if (exists) {
      bump(stats.skipped, "inventories");
      continue;
    }
    const depotId = depotMap.get(n(inv.agency)) || firstDepotId;
    const lines = [];
    let lineNumber = 0;
    for (const it of invItems.get(n(inv.id)) || []) {
      if (it.type === "pack") {
        stats.warnings.push(`inventory ${inv.id}: skipped pack line`);
        continue;
      }
      const articleId = articleMap.get(n(it.product_id));
      if (articleId == null) continue;
      lineNumber += 1;
      const counted = qty(it.quantity);
      const sign = it.way === "down" ? -1 : 1;
      lines.push({
        articleId,
        lineNumber,
        quantityTheoretical: 0,
        quantityCounted: counted,
        quantityDifference: qty(sign * counted),
      });
    }
    try {
      const created = await prisma.inventory.create({
        data: {
          societeId: societe.id,
          depotId,
          inventoryNumber,
          inventoryDate: asDate(inv.date),
          notes: [trim(inv.reference), trim(inv.description)]
            .filter(Boolean)
            .join(" — "),
          createdBy: fallbackUserId,
        },
      });
      if (lines.length) {
        await prisma.inventoryLine.createMany({
          data: lines.map((l) => ({ ...l, inventoryId: created.id })),
        });
      }
      bump(stats.created, "inventories");
    } catch (err) {
      stats.warnings.push(`INV ${inv.id}: ${err.message}`);
    }
  }

  // ── Historical stock transactions (audit only) ──
  const alreadyImportedTx = await prisma.stockTransaction.findFirst({
    where: { referenceId: { startsWith: "LEGACY-TX-" } },
    select: { id: true },
  });
  const txRows = [];
  for (const t of oldTransactions) {
    if (alreadyImportedTx) break;
    const articleId = articleMap.get(n(t.product_id));
    const depotId = depotMap.get(n(t.agence)) || firstDepotId;
    if (articleId == null || !depotId) continue;
    const mapping = TX_TYPE[t.source] || { up: "ADJUSTMENT", down: "ADJUSTMENT" };
    const direction = t.transaction_type === "down" ? "down" : "up";
    const change =
      direction === "down" ? -Math.abs(qty(t.quantity)) : Math.abs(qty(t.quantity));
    txRows.push({
      depotId,
      articleId,
      transactionType: mapping[direction],
      quantityChange: change,
      quantityAfter: 0,
      reason: `legacy ${t.source}/${t.transaction_type}`,
      referenceId: `LEGACY-TX-${t.transaction_id}`.slice(0, 100),
      createdBy: fallbackUserId,
      createdAt: asDate(t.transaction_date),
    });
  }
  if (alreadyImportedTx) {
    bump(stats.skipped, "stock_transactions", oldTransactions.length);
  } else {
    for (let i = 0; i < txRows.length; i += 500) {
      await prisma.stockTransaction.createMany({
        data: txRows.slice(i, i + 500),
      });
      bump(stats.created, "stock_transactions", Math.min(500, txRows.length - i));
    }
  }

  // ── Delivery providers ──
  for (const p of oldProviders) {
    const provider = String(p.provider_id || "AMEEX").toUpperCase();
    const exists = await prisma.deliveryProviderConfig.findFirst({
      where: { societeId: societe.id, provider, name: provider },
    });
    if (exists) {
      bump(stats.skipped, "providers");
      continue;
    }
    await prisma.deliveryProviderConfig.create({
      data: {
        societeId: societe.id,
        provider,
        name: provider,
        apiId: encrypt(String(p.identifier || p.provider_id || "")),
        apiKey: encrypt(String(p.api_key || "")),
        active: true,
        metadata: oldCities.length
          ? {
              cities: oldCities.map((c) => ({
                ameexId: n(c.ameex_id),
                name: c.name,
                price: money(c.ameex_price),
              })),
            }
          : undefined,
      },
    });
    bump(stats.created, "providers");
  }

  console.log("\n✅ Merge finished");
  console.log("Created:", stats.created);
  console.log("Reused:", stats.reused);
  console.log("Skipped:", stats.skipped);
  if (stats.warnings.length) {
    console.log(`\n⚠️  ${stats.warnings.length} warnings (first 30):`);
    for (const w of stats.warnings.slice(0, 30)) console.log("  -", w);
  }
  console.log(`\nSociété: ${societe.raisonSocial} (#${societe.id})`);
  console.log(
    "Users keep their old plaintext passwords, now bcrypt-hashed.",
  );

  await old.end();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("❌ Merge failed:", err);
  process.exitCode = 1;
});
