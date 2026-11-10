import type { UserRole } from "@/lib/api";

/**
 * Pages in the top navigation bar, in display order.
 *
 * `roles` lists who may see the link *and* open the page: `proxy.ts` sends
 * anyone else back to "/". Leave `roles` out to allow every signed-in user.
 * The backend still authorizes every API call; this only shapes the UI.
 */
export type NavItem = {
  label: string;
  href: string;
  roles?: readonly UserRole[];
};

const STAFF: readonly UserRole[] = ["staff", "admin"];
const ADMIN: readonly UserRole[] = ["admin"];

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Problems", href: "/problems" },
  { label: "Students", href: "/students", roles: STAFF },
  { label: "Progress", href: "/progress", roles: STAFF},
  { label: "Submissions", href: "/submissions", roles: STAFF },
  { label: "Leaderboard", href: "/leaderboard" },
  { label: "Staff accounts", href: "/staff", roles: ADMIN },
  { label: "Settings", href: "/settings", roles: ADMIN },
];

export const ROLE_LABELS: Record<UserRole, string> = {
  student: "Student",
  staff: "Staff",
  admin: "Admin",
};

/** True when `pathname` is `href` itself or a page below it. */
export function isUnder(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function navItemsFor(role: UserRole): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(role));
}

/**
 * Whether `role` may open `pathname`. Paths not covered by a nav item are
 * allowed; a restricted item also restricts everything below it.
 */
export function canAccessPath(pathname: string, role: UserRole): boolean {
  const item = NAV_ITEMS.find((i) => isUnder(pathname, i.href));
  return !item?.roles || item.roles.includes(role);
}
