import { prisma } from '../db.js';

// Si la cuenta recien bloqueada comparte alguna IP conocida (ver
// ConnectionLog) con OTRA cuenta que ya estaba bloqueada, esa IP se bloquea
// sola: es la señal de "alguien bloqueado volvio con una cuenta nueva e hizo
// lo mismo otra vez". La primera cuenta bloqueada NO dispara esto por si
// sola — hace falta la reincidencia de una segunda cuenta distinta desde la
// misma IP para justificar bloquear la IP entera (evita bloquear una IP
// compartida legitima, como una casa/oficina, por un solo incidente).
export async function maybeAutoBlockIp(userId) {
  const logs = await prisma.connectionLog.findMany({
    where: { userId, ip: { not: null } },
    select: { ip: true },
    distinct: ['ip'],
  });

  for (const { ip } of logs) {
    const alreadyBlocked = await prisma.ipBlock.findUnique({ where: { ip } });
    if (alreadyBlocked) continue;

    const otherBlockedOnSameIp = await prisma.connectionLog.findFirst({
      where: { ip, userId: { not: userId }, user: { blocked: true } },
    });
    if (!otherBlockedOnSameIp) continue;

    await prisma.ipBlock
      .create({ data: { ip, reason: 'Reincidencia: otra cuenta bloqueada ya se conecto desde esta IP', blockedBy: null } })
      .catch(() => null); // ya la creo otra llamada concurrente — no pasa nada
  }
}

export async function isIpBlocked(ip) {
  if (!ip) return false;
  const block = await prisma.ipBlock.findUnique({ where: { ip } });
  return !!block;
}
