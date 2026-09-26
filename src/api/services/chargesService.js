import prisma from "../../loaders/prisma.js";
import ApiError from "../utils/apiError.js";

const isSocieteAdmin = (user) =>
  !user?.isSuperAdmin && user?.roleName === "Societe_Admin";

export const isChargesAdmin = (user) =>
  !!user?.isSuperAdmin || isSocieteAdmin(user);

export const assertChargesAdmin = (user) => {
  if (!isChargesAdmin(user)) {
    throw new ApiError(
      "Accès refusé. Cette action nécessite des privilèges administrateur.",
      403,
    );
  }
};

const absAmount = (val) => Math.abs(Number(val) || 0);

const buildDateFilter = (dateFrom, dateTo) => {
  if (!dateFrom && !dateTo) return {};
  return {
    createdAt: {
      ...(dateFrom && { gte: new Date(dateFrom) }),
      ...(dateTo && { lte: new Date(dateTo) }),
    },
  };
};

const buildCaisseScope = (currentUser, societeId) => {
  if (currentUser.isSuperAdmin) {
    return societeId ? { societeId: parseInt(societeId, 10) } : {};
  }
  return { societeId: currentUser.societeId };
};

const isUnlabeled = (value) => value === true || value === "true" || value === "1";

const buildChargeWhere = ({
  currentUser,
  societeId,
  userId,
  labelId,
  unlabeled,
  dateFrom,
  dateTo,
  search,
}) => {
  const caisseScope = buildCaisseScope(currentUser, societeId);
  const and = [];

  if (userId) {
    const uid = parseInt(userId, 10);
    and.push({
      OR: [{ createdBy: uid }, { caisse: { userId: uid } }],
    });
  }

  if (search) {
    and.push({
      OR: [
        { note: { contains: search } },
        { label: { name: { contains: search } } },
        { creator: { name: { contains: search } } },
        { caisse: { name: { contains: search } } },
        { caisse: { user: { name: { contains: search } } } },
      ],
    });
  }

  return {
    transactionType: "CHARGE",
    caisse: caisseScope,
    ...(isUnlabeled(unlabeled)
      ? { labelId: null }
      : labelId
        ? { labelId: parseInt(labelId, 10) }
        : {}),
    ...buildDateFilter(dateFrom, dateTo),
    ...(and.length ? { AND: and } : {}),
  };
};

const CHARGE_INCLUDE = {
  caisse: {
    select: {
      id: true,
      name: true,
      caisseType: true,
      user: {
        select: {
          id: true,
          name: true,
          role: { select: { name: true } },
        },
      },
    },
  },
  label: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
};

const mapByLabel = (grouped, labels) => {
  const labelMap = new Map(labels.map((l) => [l.id, l.name]));
  return grouped
    .map((row) => ({
      id: row.labelId,
      name: row.labelId == null ? null : labelMap.get(row.labelId) || null,
      amount: absAmount(row._sum.amount),
      count: row._count.id,
    }))
    .sort((a, b) => b.amount - a.amount);
};

export const getCharges = async (query, currentUser, societeId = null) => {
  assertChargesAdmin(currentUser);

  const {
    page = 1,
    limit = 20,
    userId,
    labelId,
    unlabeled,
    dateFrom,
    dateTo,
    search,
  } = query;

  const take = Math.min(parseInt(limit, 10) || 20, 100);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const skip = (pageNum - 1) * take;

  const where = buildChargeWhere({
    currentUser,
    societeId,
    userId,
    labelId,
    unlabeled,
    dateFrom,
    dateTo,
    search,
  });

  const labelBreakdownWhere = buildChargeWhere({
    currentUser,
    societeId,
    userId,
    dateFrom,
    dateTo,
    search,
  });

  const [transactions, total, totals, grouped] = await Promise.all([
    prisma.caisseTransaction.findMany({
      where,
      skip,
      take,
      include: CHARGE_INCLUDE,
      orderBy: { createdAt: "desc" },
    }),
    prisma.caisseTransaction.count({ where }),
    prisma.caisseTransaction.aggregate({
      where,
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.caisseTransaction.groupBy({
      by: ["labelId"],
      where: labelBreakdownWhere,
      _sum: { amount: true },
      _count: { id: true },
    }),
  ]);

  const labelIds = grouped.map((row) => row.labelId).filter((id) => id != null);
  const labels = labelIds.length
    ? await prisma.caisseLabel.findMany({
        where: { id: { in: labelIds } },
        select: { id: true, name: true },
      })
    : [];

  const byLabel = mapByLabel(grouped, labels);

  return {
    data: transactions,
    byLabel,
    summary: {
      totalAmount: absAmount(totals._sum.amount),
      count: totals._count.id || 0,
      labelCount: byLabel.length,
    },
    pagination: {
      total,
      numberOfPages: Math.ceil(total / take) || 1,
      page: pageNum,
      limit: take,
    },
  };
};
