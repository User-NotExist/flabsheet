import type { UserRole } from "@/lib/api";

/**
 * Pages in the top navigation bar, in display order.
 *
 * `href` is the section the item stands for: it decides who may open the
 * pages below it and when the link shows as active.
 *
 * `roles` lists who may see the link *and* open the page: `proxy.ts` sends
 * anyone else back to "/". Leave `roles` out to allow every signed-in user.
 * The backend still authorizes every API call; this only shapes the UI.
 *
 * `hrefByRole` sends some roles to a different page when they click the link
 * (e.g. students to their own progress). Keep those targets under `href` so
 * the link stays highlighted there and `roles` still governs access.
 */
export type NavItem = {
  label: string;
  href: string;
  roles?: readonly UserRole[];
  hrefByRole?: Partial<Record<UserRole, string>>;
};

/** A nav item resolved for one role, ready to render. */
export type NavLink = {
  label: string;
  /** Where the link goes for this role. */
  href: string;
  /** Section prefix used for the active state. */
  section: string;
};

const STAFF: readonly UserRole[] = ["staff", "admin"];
const ADMIN: readonly UserRole[] = ["admin"];

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Problems", href: "/problems", hrefByRole: { staff: "/manage/problems", admin: "/manage/problems" }},
  { label: "Students", href: "/manage/students", roles: STAFF },
  { label: "Progress", href: "/manage/progress", roles: STAFF },
  { label: "Submissions", href: "/manage/submissions", roles: STAFF },
  { label: "Leaderboard", href: "/leaderboard", hrefByRole: { staff: "/manage/leaderboard", admin: "/manage/leaderboard" }},
  { label: "Staff accounts", href: "/admin/staff", roles: ADMIN },
  { label: "Settings", href: "/admin/settings", roles: ADMIN },
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

/** The links `role` may see, with each `href` resolved for that role. */
export function navItemsFor(role: UserRole): NavLink[] {
  return NAV_ITEMS.filter(
    (item) => !item.roles || item.roles.includes(role),
  ).map(({ label, href, hrefByRole }) => ({
    label,
    href: hrefByRole?.[role] ?? href,
    section: href,
  }));
}

/**
 * Whether `role` may open `pathname`. Paths not covered by a nav item are
 * allowed; a restricted item also restricts everything below it.
 */
export function canAccessPath(pathname: string, role: UserRole): boolean {
  const item = NAV_ITEMS.find((i) => isUnder(pathname, i.href));
  return !item?.roles || item.roles.includes(role);
}
