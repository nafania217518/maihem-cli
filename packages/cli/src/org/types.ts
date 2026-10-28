// Shared contracts for orgs: a declared development department run by an org daemon.

// --- declaration (apply file: `orgs:`) ---
export const ROLES = ["ba", "sa", "pm", "tl", "dev"] as const;
export type Role = (typeof ROLES)[number];
// the grid (docs/org-design.md §2): level sets scope and default reasoning, track sets content
export type Level = "strategic" | "project" | "cycle";
export const LEVEL: Record<Role, Level> = { ba: "strategic", sa: "strategic", pm: "project", tl: "project", dev: "cycle" };
export const TRACK: Record<Role, "business" | "technical"> = { ba: "business", pm: "business", sa: "technical", tl: "technical", dev: "technical" };
export const REASONING: Record<Level, "high" | "medium" | "low"> = { strategic: "high", project: "medium", cycle: "low" };
export interface Member { role: Role; definition: string; reports_to?: string } // reports_to: a DEV's TL, only with several TLs
// unset caps take their defaults where used: review_rounds 3, noop_sessions 3, retry_seconds 30, retry_max_seconds 600, triage_chars 300
export interface Limits { parallel: number; tokens?: number; review_rounds?: number; noop_sessions?: number; retry_seconds?: number; retry_max_seconds?: number; triage_chars?: number }
export interface Org {
  name: string;
  repo: string; // agents' workdir; "~" expands at start
  members: Record<string, Member>;
  limits: Limits;
}

// --- tracker (SQLite: MAIHEM_HOME/orgs/<org>/org.db) ---
export const STATUSES = ["triage", "needs_reply", "todo", "in_progress", "in_review", "done", "canceled", "duplicate"] as const;
export type Status = (typeof STATUSES)[number];
export const CLOSED: readonly Status[] = ["done", "canceled", "duplicate"];
export const isOpen = (s: Status): boolean => !CLOSED.includes(s);

export type Label = "bug" | "other";
export type Priority = 0 | 1 | 2 | 3 | 4; // none, low, medium, high, urgent
export type TicketKind = "normal" | "requirements" | "roadmap" | "breakdown" | "acceptance" | "summary" | "final";
export interface Ticket {
  id: string; // "T-n"
  title: string;
  description: string;
  status: Status;
  label: Label;
  priority: Priority;
  ord: number; // manual order within a priority
  owner: string; // the creator
  assignee?: string;
  milestone?: string;
  parent?: string;
  branch?: string;
  merged?: string; // squash commit
  summary?: string; // the assignee's work summary from its last submit
  kind: TicketKind;
  gate?: "pending" | "approved"; // human approval
  asker?: string; // needs_reply: who asked
  return_status?: Status; // needs_reply: the status to restore
  return_assignee?: string; // needs_reply: the member to restore
  created: number;
  updated: number;
}
export type ApprovalState = "pending" | "approved" | "changes";
export interface Approval { ticket: string; reviewer: string; state: ApprovalState }
export type RelationKind = "blocks" | "related" | "duplicate";
export interface Relation { from: string; to: string; kind: RelationKind } // from blocks / relates to / duplicates to
export interface Milestone { id: string; name: string; description: string; ord: number } // id "M0".."Mn"
export interface Comment { id: number; ticket: string; author: string; text: string; at: number }
export interface InboxItem {
  id: string; // "Q-1"
  kind: "approval";
  author: string; // member name, or "org"
  ticket?: string;
  text: string;
  files: string[];
  state: "open" | "answered";
  answer?: string;
  approved?: boolean; // approvals only
  at: number;
}
export interface OrgEvent { id: number; at: number; kind: string; actor: string; ticket?: string; data: Record<string, unknown> }
export interface Wake { member: string; ticket: string; kind: "triage" | "work" | "review" | "reply" }
