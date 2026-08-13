import { prisma } from '../db.js';

// Escribe una fila de historial. `target` es el usuario afectado (para
// tomar la foto de su username en ese momento); `actor` es quien hizo el
// cambio (puede ser el mismo usuario, o un admin/moderador distinto, o null
// si fue el sistema). Ver prisma/schema.prisma para por que userId es
// opcional (el registro debe sobrevivir aunque la cuenta se elimine despues).
export function logAudit({ target, actor, field, oldValue, newValue, reason }) {
  return prisma.auditLog.create({
    data: {
      userId: target.id,
      targetUsername: target.username,
      field,
      oldValue: oldValue != null ? String(oldValue) : null,
      newValue: newValue != null ? String(newValue) : null,
      reason: reason || null,
      changedBy: actor?.id || null,
      changedByUsername: actor?.username || null,
    },
  });
}

export function logAuditMany(entries) {
  return prisma.auditLog.createMany({
    data: entries.map((e) => ({
      userId: e.target.id,
      targetUsername: e.target.username,
      field: e.field,
      oldValue: e.oldValue != null ? String(e.oldValue) : null,
      newValue: e.newValue != null ? String(e.newValue) : null,
      reason: e.reason || null,
      changedBy: e.actor?.id || null,
      changedByUsername: e.actor?.username || null,
    })),
  });
}
