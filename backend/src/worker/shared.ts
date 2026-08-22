/** Shared run-execution helpers extracted from worker.ts for the staged split (todo 12). */
export function tarMemberPathUnsafe(member: string): boolean {
  if (member === "" || member === "/" || member.startsWith("/") || member.includes("\\")) return true;
  const parts = member.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return true;
  }
  return false;
}

export function tarMemberIsForbiddenSpecial(firstChar: string): boolean {
  return firstChar !== "-" && firstChar !== "0" && firstChar !== "5" && firstChar !== "g" && firstChar !== "x";
}
