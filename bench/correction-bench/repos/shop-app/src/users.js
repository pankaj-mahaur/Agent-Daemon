import { newId } from "#app/lib/ids.js";

const users = new Map();

export function addUser(email) {
  const user = { id: newId("usr"), email, joinedAt: Date.now() };
  users.set(user.id, user);
  return user;
}

export const getUser = (id) => users.get(id) ?? null;
