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
 * (e.g. staff to `/manage/problems` instead of the student `/problems`). Such
 * a target is a section of its own: only the roles mapped to it may open the
 * pages below it, and the link shows as active there too.
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
  /** The item's own section. The link is active under it and under `href`. */
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

/** Whether `link` should show as the current page for `pathname`. */
export function isActive(pathname: string, link: NavLink): boolean {
  return isUnder(pathname, link.section) || isUnder(pathname, link.href);
}

/**
 * Whether `role` may open `pathname`. Paths not covered by a nav item are
 * allowed; a restricted item also restricts everything below it.
 */
export function canAccessPath(pathname: string, role: UserRole): boolean {
  for (const item of NAV_ITEMS) {
    const allowed = !item.roles || item.roles.includes(role);
    // Role-specific targets first: /manage/problems is not below /problems,
    // so without this check any signed-in user could open it.
    for (const target of new Set(Object.values(item.hrefByRole ?? {}))) {
      if (isUnder(pathname, target)) {
        return allowed && item.hrefByRole?.[role] === target;
      }
    }
    if (isUnder(pathname, item.href)) return allowed;
  }
  return true;
}
