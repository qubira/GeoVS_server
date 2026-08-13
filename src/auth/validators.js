const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function normalizeUsername(username) {
  return String(username || '').trim();
}

export function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

export function isValidUsername(username) {
  return USERNAME_RE.test(username);
}

export function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 72;
}

export function isValidAge(age) {
  const n = Number(age);
  return Number.isInteger(n) && n >= 5 && n <= 100;
}

// DTO seguro: nunca exponer passwordHash al cliente.
export function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    age: user.age,
    role: user.role,
    blocked: user.blocked,
    createdAt: user.createdAt,
  };
}
