import prisma from "../../loaders/prisma.js";
import ApiError from "../utils/apiError.js";

const LEAVE_INCLUDE = {
  user: { select: { id: true, name: true, email: true, role: { select: { name: true } } } },
  societe: { select: { id: true, raisonSocial: true } },
};

const toDateOnly = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const inclusiveDays = (start, end) => {
  const ms = end.getTime() - start.getTime();
  return Math.round(ms / 86400000) + 1;
};

const daysInYear = (start, end, year) => {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31));
  const from = start > yearStart ? start : yearStart;
  const to = end < yearEnd ? end : yearEnd;
  if (from > to) return 0;
  return inclusiveDays(from, to);
};

const resolveSocieteId = (currentUser, societeId) => {
  if (currentUser.isSuperAdmin) {
    return societeId ? parseInt(societeId, 10) : null;
  }
  if (!currentUser.societeId) {
    throw new ApiError("Aucune société associée à votre compte", 400);
  }
  return currentUser.societeId;
};

const assertLeaveAccess = async (id, currentUser) => {
  const leave = await prisma.employeeLeave.findUnique({
    where: { id: parseInt(id, 10) },
    include: LEAVE_INCLUDE,
  });
  if (!leave) throw new ApiError("Congé introuvable", 404);
  if (
    !currentUser.isSuperAdmin &&
    leave.societeId !== currentUser.societeId
  ) {
    throw new ApiError("Accès refusé", 403);
  }
  return leave;
};

const assertNoOverlap = async ({ userId, startDate, endDate, excludeId }) => {
  const overlap = await prisma.employeeLeave.findFirst({
    where: {
      userId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    },
    select: { id: true, startDate: true, endDate: true },
  });
  if (overlap) {
    throw new ApiError(
      "Cet employé a déjà un congé sur cette période",
      409,
    );
  }
};

export const getEmployees = async (currentUser, societeId) => {
  const resolved = resolveSocieteId(currentUser, societeId);
  const users = await prisma.user.findMany({
    where: {
      active: true,
      hidden: false,
      isSuperAdmin: false,
      ...(resolved ? { societeId: resolved } : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      societeId: true,
      role: { select: { name: true } },
    },
    orderBy: { name: "asc" },
    take: 1000,
  });
  return users;
};

export const getAll = async (query, currentUser) => {
  const {
    page = 1,
    limit = 20,
    userId,
    year,
    search,
    societeId,
  } = query;
  const parsedPage = parseInt(page, 10) || 1;
  const parsedLimit = Math.min(parseInt(limit, 10) || 20, 100);
  const resolvedSocieteId = resolveSocieteId(currentUser, societeId);
  const selectedYear = parseInt(year, 10) || new Date().getFullYear();
  const yearStart = new Date(Date.UTC(selectedYear, 0, 1));
  const yearEnd = new Date(Date.UTC(selectedYear, 11, 31));

  const where = {
    startDate: { lte: yearEnd },
    endDate: { gte: yearStart },
    ...(resolvedSocieteId ? { societeId: resolvedSocieteId } : {}),
    ...(userId ? { userId: parseInt(userId, 10) } : {}),
    ...(search
      ? {
          OR: [
            { user: { name: { contains: search } } },
            { user: { email: { contains: search } } },
            { note: { contains: search } },
          ],
        }
      : {}),
  };

  const [total, rows, yearLeaves] = await Promise.all([
    prisma.employeeLeave.count({ where }),
    prisma.employeeLeave.findMany({
      where,
      include: LEAVE_INCLUDE,
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      skip: (parsedPage - 1) * parsedLimit,
      take: parsedLimit,
    }),
    prisma.employeeLeave.findMany({
      where: {
        startDate: { lte: yearEnd },
        endDate: { gte: yearStart },
        ...(resolvedSocieteId ? { societeId: resolvedSocieteId } : {}),
        ...(userId ? { userId: parseInt(userId, 10) } : {}),
      },
      select: {
        userId: true,
        startDate: true,
        endDate: true,
        user: { select: { name: true } },
      },
    }),
  ]);

  const daysByUser = new Map();
  for (const leave of yearLeaves) {
    const days = daysInYear(leave.startDate, leave.endDate, selectedYear);
    const prev = daysByUser.get(leave.userId) || {
      userId: leave.userId,
      userName: leave.user?.name || "—",
      days: 0,
    };
    prev.days += days;
    daysByUser.set(leave.userId, prev);
  }

  const data = rows.map((leave) => ({
    ...leave,
    daysInYear: daysInYear(leave.startDate, leave.endDate, selectedYear),
    daysThisYear: daysByUser.get(leave.userId)?.days || 0,
  }));

  const yearTotals = [...daysByUser.values()].sort(
    (a, b) => b.days - a.days || String(a.userName).localeCompare(String(b.userName)),
  );

  return {
    data,
    year: selectedYear,
    yearTotals,
    yearDays: yearTotals.reduce((s, r) => s + r.days, 0),
    pagination: {
      total,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.ceil(total / parsedLimit),
    },
  };
};

export const create = async (payload, currentUser) => {
  const startDate = toDateOnly(payload.startDate);
  const endDate = toDateOnly(payload.endDate);
  if (!startDate || !endDate) {
    throw new ApiError("Dates de congé invalides", 400);
  }
  if (endDate < startDate) {
    throw new ApiError("La date de fin doit être après la date de début", 400);
  }

  const userId = parseInt(payload.userId, 10);
  const employee = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, societeId: true, isSuperAdmin: true, active: true },
  });
  if (!employee || !employee.active) {
    throw new ApiError("Employé introuvable", 404);
  }
  if (employee.isSuperAdmin) {
    throw new ApiError("Impossible d'ajouter un congé à un super administrateur", 400);
  }

  const societeId = resolveSocieteId(currentUser, payload.societeId || employee.societeId);
  if (!societeId) {
    throw new ApiError("La société est requise", 400);
  }
  if (employee.societeId && employee.societeId !== societeId) {
    throw new ApiError("Cet employé n'appartient pas à cette société", 403);
  }

  await assertNoOverlap({ userId, startDate, endDate });

  return prisma.employeeLeave.create({
    data: {
      societeId,
      userId,
      startDate,
      endDate,
      days: inclusiveDays(startDate, endDate),
      note: payload.note?.trim() || null,
      createdBy: currentUser.id,
    },
    include: LEAVE_INCLUDE,
  });
};

export const update = async (id, payload, currentUser) => {
  const existing = await assertLeaveAccess(id, currentUser);
  const startDate = toDateOnly(payload.startDate ?? existing.startDate);
  const endDate = toDateOnly(payload.endDate ?? existing.endDate);
  if (!startDate || !endDate) {
    throw new ApiError("Dates de congé invalides", 400);
  }
  if (endDate < startDate) {
    throw new ApiError("La date de fin doit être après la date de début", 400);
  }

  const userId = payload.userId
    ? parseInt(payload.userId, 10)
    : existing.userId;

  if (userId !== existing.userId) {
    const employee = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, societeId: true, isSuperAdmin: true, active: true },
    });
    if (!employee || !employee.active) {
      throw new ApiError("Employé introuvable", 404);
    }
    if (
      !currentUser.isSuperAdmin &&
      employee.societeId !== currentUser.societeId
    ) {
      throw new ApiError("Accès refusé", 403);
    }
  }

  await assertNoOverlap({
    userId,
    startDate,
    endDate,
    excludeId: existing.id,
  });

  return prisma.employeeLeave.update({
    where: { id: existing.id },
    data: {
      userId,
      startDate,
      endDate,
      days: inclusiveDays(startDate, endDate),
      note: payload.note !== undefined ? payload.note?.trim() || null : existing.note,
    },
    include: LEAVE_INCLUDE,
  });
};

export const remove = async (id, currentUser) => {
  const existing = await assertLeaveAccess(id, currentUser);
  await prisma.employeeLeave.delete({ where: { id: existing.id } });
  return { message: "Congé supprimé" };
};
