import prisma from "../../loaders/prisma.js";
import { CANONICAL_BL_WHERE } from "../utils/canonicalBonLivraison.js";

const TOLERANCE = 0.001;

const buildKeywordOr = (keyword, partnerField) => {
  const or = [
    { documentNumber: { contains: keyword } },
    { [partnerField]: { name: { contains: keyword } } },
  ];
  return or;
};

const paginate = (rows, page, limit) => {
  const total = rows.length;
  const numberOfPages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  return {
    data: rows.slice(start, start + limit),
    results: total,
    pagination: { page, limit, numberOfPages },
  };
};

const computeSummary = (rows) => ({
  documentCount: rows.length,
  totalAmountDue: rows.reduce((s, r) => s + r.amountDue, 0),
  totalPaid: rows.reduce((s, r) => s + r.amountPaid, 0),
  totalReste: rows.reduce((s, r) => s + r.reste, 0),
  totalDebit: rows.reduce((s, r) => s + (r.debit || 0), 0),
  totalCredit: rows.reduce((s, r) => s + (r.credit || 0), 0),
});

const matchesKeyword = (row, keyword) => {
  if (!keyword) return true;
  const q = keyword.toLowerCase();
  return (
    (row.documentNumber || "").toLowerCase().includes(q) ||
    (row.partnerName || "").toLowerCase().includes(q) ||
    (row.partnerPhone || "").toLowerCase().includes(q)
  );
};

const DOCUMENT_TYPES = new Set([
  "BON_LIVRAISON",
  "REGLEMENT",
  "BON_RETOUR",
]);

/** Prisma to-one relation filter: scalars go under `is`, not next to `isNot`. */
const relatedWithOptionalDate = (startDate, endDate) => {
  if (!startDate && !endDate) return { isNot: null };
  return {
    is: {
      documentDate: {
        ...(startDate && { gte: startDate }),
        ...(endDate && { lte: endDate }),
      },
    },
  };
};

const canonicalBlWithOptionalDate = (startDate, endDate) => ({
  is: {
    ...CANONICAL_BL_WHERE,
    ...((startDate || endDate) && {
      documentDate: {
        ...(startDate && { gte: startDate }),
        ...(endDate && { lte: endDate }),
      },
    }),
  },
});

/**
 * Situation client — bons de livraison, règlements and bons de retour.
 * paymentStatus: all (default) | paid | unpaid
 * documentType: BON_LIVRAISON | REGLEMENT | BON_RETOUR
 */
export const getClientSituation = async (query, societeId) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
  const keyword = query.keyword?.trim() || "";
  const clientId = query.clientId ? parseInt(query.clientId, 10) : undefined;
  const startDate = query.startDate ? new Date(query.startDate) : null;
  const endDate = query.endDate ? new Date(query.endDate) : null;
  const paymentStatus = ["paid", "unpaid"].includes(query.paymentStatus)
    ? query.paymentStatus
    : "all";
  const documentType = DOCUMENT_TYPES.has(query.documentType)
    ? query.documentType
    : null;

  const societeWhere = societeId ? { societeId } : {};
  const clientWhere = clientId ? { clientId } : {};

  const [blDocs, retourDocs, reglements] = await Promise.all([
    prisma.clientDocument.findMany({
      where: {
        ...societeWhere,
        ...clientWhere,
        status: { not: "CANCELLED" },
        bonLivraison: canonicalBlWithOptionalDate(startDate, endDate),
      },
      select: {
        id: true,
        documentNumber: true,
        amountDue: true,
        amountPaid: true,
        totalTTC: true,
        status: true,
        clientId: true,
        clientName: true,
        client: { select: { id: true, name: true, phone: true } },
        bonLivraison: {
          select: { id: true, documentDate: true, type: true },
        },
      },
    }),
    prisma.clientDocument.findMany({
      where: {
        ...societeWhere,
        ...clientWhere,
        status: { not: "CANCELLED" },
        bonRetourClient: relatedWithOptionalDate(startDate, endDate),
      },
      select: {
        id: true,
        documentNumber: true,
        amountDue: true,
        amountPaid: true,
        totalTTC: true,
        status: true,
        clientId: true,
        clientName: true,
        client: { select: { id: true, name: true, phone: true } },
        bonRetourClient: { select: { id: true, documentDate: true } },
      },
    }),
    prisma.reglementClient.findMany({
      where: {
        ...societeWhere,
        ...clientWhere,
        ...((startDate || endDate) && {
          date: {
            ...(startDate && { gte: startDate }),
            ...(endDate && { lte: endDate }),
          },
        }),
      },
      select: {
        id: true,
        date: true,
        montantRegle: true,
        clientId: true,
        client: { select: { id: true, name: true, phone: true } },
      },
    }),
  ]);

  const blRows = blDocs.map((d) => {
    const amountDue = Number(d.amountDue);
    const amountPaid = Number(d.amountPaid);
    const reste = amountDue - amountPaid;
    const isPaid = reste <= TOLERANCE;
    const blType = d.bonLivraison?.type;
    return {
      id: `bl-${d.bonLivraison?.id ?? d.id}`,
      sourceId: d.bonLivraison?.id ?? d.id,
      documentId: d.id,
      documentType: "BON_LIVRAISON",
      documentNumber: d.documentNumber,
      documentDate: d.bonLivraison?.documentDate ?? null,
      clientId: d.clientId,
      partnerName: d.client?.name ?? d.clientName ?? "—",
      partnerPhone: d.client?.phone ?? null,
      debit: amountDue,
      credit: 0,
      amountDue,
      amountPaid,
      reste: isPaid ? 0 : reste,
      isPaid,
      status: d.status,
      href:
        blType === "ADVANCED"
          ? `/commandes/${d.bonLivraison?.id ?? d.id}`
          : `/bon-livraisons/${d.bonLivraison?.id ?? d.id}/preview`,
    };
  });

  const retourRows = retourDocs.map((d) => {
    const credit = Number(d.totalTTC ?? d.amountDue ?? 0);
    const completed = !["DRAFT", "CANCELLED"].includes(d.status);
    return {
      id: `brc-${d.bonRetourClient?.id ?? d.id}`,
      sourceId: d.bonRetourClient?.id ?? d.id,
      documentId: d.id,
      documentType: "BON_RETOUR",
      documentNumber: d.documentNumber,
      documentDate: d.bonRetourClient?.documentDate ?? null,
      clientId: d.clientId,
      partnerName: d.client?.name ?? d.clientName ?? "—",
      partnerPhone: d.client?.phone ?? null,
      debit: 0,
      credit: completed ? credit : 0,
      amountDue: 0,
      amountPaid: completed ? credit : 0,
      reste: 0,
      isPaid: true,
      status: d.status,
      href: `/bon-retour-clients/${d.bonRetourClient?.id ?? d.id}/preview`,
    };
  });

  const reglementRows = reglements.map((r) => {
    const credit = Number(r.montantRegle);
    return {
      id: `rc-${r.id}`,
      sourceId: r.id,
      documentId: r.id,
      documentType: "REGLEMENT",
      documentNumber: `RC-${r.id}`,
      documentDate: r.date ?? null,
      clientId: r.clientId,
      partnerName: r.client?.name ?? "—",
      partnerPhone: r.client?.phone ?? null,
      debit: 0,
      credit,
      amountDue: 0,
      amountPaid: credit,
      reste: 0,
      isPaid: true,
      status: "PAID",
      href: "/reglements-client",
    };
  });

  const rows = [...blRows, ...retourRows, ...reglementRows]
    .filter((r) => matchesKeyword(r, keyword))
    .filter((r) => !documentType || r.documentType === documentType)
    .filter((r) => {
      if (paymentStatus === "paid") {
        return r.documentType !== "BON_LIVRAISON" || r.isPaid;
      }
      if (paymentStatus === "unpaid") {
        return r.documentType === "BON_LIVRAISON" && !r.isPaid;
      }
      return true;
    })
    .sort((a, b) => {
      const da = a.documentDate ? new Date(a.documentDate).getTime() : 0;
      const db = b.documentDate ? new Date(b.documentDate).getTime() : 0;
      return db - da;
    });

  const summary = computeSummary(rows);
  const { data, results, pagination } = paginate(rows, page, limit);

  return { data, summary, results, pagination };
};

/**
 * Situation fournisseur — unpaid / partial Bon de réception lines.
 */
export const getFournisseurSituation = async (query, societeId) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
  const keyword = query.keyword?.trim();
  const fournisseurId = query.fournisseurId
    ? parseInt(query.fournisseurId, 10)
    : undefined;
  const startDate = query.startDate ? new Date(query.startDate) : null;
  const endDate = query.endDate ? new Date(query.endDate) : null;

  const where = {
    bonReception: relatedWithOptionalDate(startDate, endDate),
  };

  if (societeId) where.societeId = societeId;
  if (fournisseurId) where.fournisseurId = fournisseurId;
  if (keyword) where.OR = buildKeywordOr(keyword, "fournisseur");

  const docs = await prisma.fournisseurDocument.findMany({
    where,
    select: {
      id: true,
      documentNumber: true,
      amountDue: true,
      amountPaid: true,
      totalTTC: true,
      status: true,
      fournisseurId: true,
      fournisseur: { select: { id: true, name: true, phone: true } },
      bonReception: { select: { id: true, documentDate: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const rows = docs
    .map((d) => {
      const amountDue = Number(d.amountDue);
      const amountPaid = Number(d.amountPaid);
      const reste = amountDue - amountPaid;
      return {
        id: d.bonReception?.id ?? d.id,
        documentId: d.id,
        documentNumber: d.documentNumber,
        documentDate: d.bonReception?.documentDate ?? null,
        fournisseurId: d.fournisseurId,
        partnerName: d.fournisseur?.name ?? "—",
        partnerPhone: d.fournisseur?.phone ?? null,
        amountDue,
        amountPaid,
        reste,
        status: d.status,
      };
    })
    .filter((r) => r.reste > TOLERANCE);

  const summary = computeSummary(rows);
  const { data, results, pagination } = paginate(rows, page, limit);

  return { data, summary, results, pagination };
};
