import { GlobeIcon, LockIcon, MegaphoneIcon, PinIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type {
  ClarificationAuthor,
  ClarificationListItem,
  ClarificationStatus,
} from "@/lib/api";
import { ROLE_LABELS } from "@/lib/navigation";

export const STATUS_LABELS: Record<ClarificationStatus, string> = {
  open: "Open",
  answered: "Answered",
  closed: "Closed",
};

const STATUS_CLASSES: Record<ClarificationStatus, string> = {
  open: "bg-warning text-warning-foreground",
  answered: "bg-success text-success-foreground",
  closed: "bg-secondary text-muted-foreground",
};

/**
 * The badges of a thread: announcement, pinned, private and the status.
 * An announcement shows no status: it is never waiting for an answer.
 */
export function ThreadBadges({ thread }: { thread: ClarificationListItem }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {thread.pinned && (
        <Badge variant="outline" className="gap-1">
          <PinIcon aria-hidden className="size-3" />
          Pinned
        </Badge>
      )}
      {thread.kind === "announcement" ? (
        <Badge variant="secondary" className="gap-1 bg-info text-info-foreground">
          <MegaphoneIcon aria-hidden className="size-3" />
          Announcement
        </Badge>
      ) : (
        <Badge variant="secondary" className={STATUS_CLASSES[thread.status]}>
          {STATUS_LABELS[thread.status]}
        </Badge>
      )}
      {thread.visibility === "private" ? (
        <Badge variant="outline" className="gap-1" title="Only the author and staff can see it.">
          <LockIcon aria-hidden className="size-3" />
          Private
        </Badge>
      ) : (
        thread.kind === "question" && (
          <Badge variant="outline" className="gap-1" title="Every student can see it.">
            <GlobeIcon aria-hidden className="size-3" />
            Public
          </Badge>
        )
      )}
      {thread.tags.map((tag) => (
        <Badge key={tag} variant="ghost" className="border border-dashed">
          {tag}
        </Badge>
      ))}
    </span>
  );
}

/** "You", or the name; staff also see the login ID, and staff replies are marked. */
export function AuthorName({
  author,
  role,
}: {
  author: ClarificationAuthor;
  /** The role to mark, when it differs from the author's current one (a reply's). */
  role?: ClarificationAuthor["role"];
}) {
  const shown = role ?? author.role;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-medium text-foreground">
        {author.is_me ? "You" : author.display_name}
      </span>
      {author.login_id && !author.is_me && (
        <span className="text-muted-foreground">({author.login_id})</span>
      )}
      {shown && shown !== "student" && (
        <Badge variant="secondary" className="h-5 bg-primary px-1.5 text-primary-foreground">
          {ROLE_LABELS[shown]}
        </Badge>
      )}
    </span>
  );
}
