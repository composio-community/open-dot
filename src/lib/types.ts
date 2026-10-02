// Shared between the dot runtime (server) and the UI (client).

// Dots are round "puffball" characters: a soft body, stubby arms, big shiny eyes, blush, and chunky feet.
export const SHAPES = ["round", "chubby", "tall"] as const;
export const MATERIALS = ["soft", "glossy", "velvet", "toon"] as const;
export const EYES = ["classic", "happy", "wide", "wink"] as const;
export const ACCESSORIES = ["none", "bow", "cap", "antenna", "halo", "sprout", "headphones"] as const;
/** Body colors: soft pastels. */
export const COLORS = [
  "#ffa7c4", "#ffb8a1", "#ffd98a", "#c8ec8f", "#97e0b8", "#8fdcd6",
  "#9fcbff", "#b9b3ff", "#dcb4f5", "#f4efe6", "#c9c3bb", "#6e6a78",
] as const;
/** Feet colors: deeper tones that anchor the body. */
export const FEET_COLORS = [
  "#d8195f", "#e0492d", "#d98a00", "#4f9a2f", "#1f8f5f", "#138a8a",
  "#2a6fdb", "#5b46d6", "#9b3cc4", "#3b3842", "#8a5a3c", "#f4f4f4",
] as const;
export const EYE_COLORS = ["#2b5fd9", "#1f8f5f", "#8a4bd6", "#c2410c", "#3b3842"] as const;

export type Shape = (typeof SHAPES)[number];
export type Material = (typeof MATERIALS)[number];
export type Eyes = (typeof EYES)[number];
export type Accessory = (typeof ACCESSORIES)[number];

export type Look = {
  shape: Shape;
  color: string; // body
  accent: string; // feet (and accessory trim)
  eyeColor: string;
  material: Material;
  eyes: Eyes;
  accessory: Accessory;
};

export type DotStatus = "idle" | "working" | "waiting" | "paused";

export type Dot = {
  id: string;
  name: string;
  purpose: string;
  instructions: string;
  look: Look;
  status: DotStatus;
  activity: string | null; // e.g. "Searching the web"
  localAccess: boolean; // may this dot run things on the user's own computer?
  model: string | null; // null = use the default model
  createdAt: number;
};

export type MessageRole = "user" | "dot" | "activity" | "card" | "system";

export type CardKind = "approval" | "question" | "connect";
export type CardStatus = "pending" | "approved" | "denied" | "answered" | "expired";

export type CardData = {
  kind: CardKind;
  status: CardStatus;
  title: string;
  detail?: string;
  tool?: string;
  options?: string[];
  answer?: string;
  ruleAction?: string; // natural-language action used if the user picks "Always allow"
  toolkit?: string; // connect cards: Composio toolkit slug
  url?: string; // connect cards: OAuth link
};

/** A file attached to a message (uploaded by the user or shared by a dot). */
export type Attachment = { id: string; name: string; mime: string; size: number };

export type Message = {
  id: string;
  dotId: string;
  role: MessageRole;
  text: string;
  title?: string | null;
  card?: CardData | null;
  from?: string | null; // "routine:<name>" | "dot:<name>" | null
  attachments?: Attachment[] | null;
  channelId?: string | null; // set for messages in a group channel (dotId is the author, or the lead for user posts)
  conversationId?: string | null;
  createdAt: number;
};

/** One chat thread with a dot (like a ChatGPT conversation). Memory, skills and rules are shared across them. */
export type Conversation = { id: string; dotId: string; title: string; model: string | null; createdAt: number; updatedAt: number };

/** A group chat: the user talks to several dots; the lead coordinates and delegates to members. */
export type Channel = { id: string; name: string; leadId: string; memberIds: string[]; createdAt: number };

export type RuleDecision = "allow" | "ask" | "never";
export type Rule = { id: string; dotId: string | null; action: string; decision: RuleDecision; createdAt: number };
export type Memory = { id: string; dotId: string; text: string; createdAt: number };
export type Skill = { id: string; dotId: string; name: string; description: string; body: string; createdAt: number };
/** A Composio trigger: when something happens in one of the user's apps, a dot runs an instruction. */
// Picking a trigger: apps connected for triggers, and the events each app offers.
export type TriggerApp = { slug: string; name: string; connected: boolean };
export type TriggerField = { name: string; type: string; title: string; description: string; required: boolean; enum?: string[]; default?: unknown };
export type TriggerType = { slug: string; name: string; description: string; fields: TriggerField[] };

export type AppTrigger = {
  id: string;
  dotId: string;
  composioId: string;
  slug: string; // e.g. GMAIL_NEW_GMAIL_MESSAGE
  toolkit: string; // e.g. gmail
  name: string; // e.g. "New Gmail message"
  config: Record<string, unknown>;
  instruction: string;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  lastError: string | null;
};

export type Routine = {
  id: string;
  dotId: string;
  name: string;
  instruction: string;
  schedule: string; // cron expression
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
};
export type PasswordEntry = { id: string; site: string; username: string; createdAt: number }; // secret never leaves the server

export type Snapshot = {
  dots: Dot[];
  messages: Message[];
  routines: Routine[];
  triggers: AppTrigger[];
  rules: Rule[];
  memories: Memory[];
  skills: Skill[];
  passwords: PasswordEntry[];
  computer: ComputerInfo;
  apps: ToolkitState[];
  channels: Channel[];
  conversations: Conversation[];
};

/** A Composio app the user can connect (Gmail, Slack…). */
export type ToolkitState = { slug: string; name: string; logo?: string; connected: boolean; accountId?: string };

export type ComputerInfo = {
  mode: "cloud" | "docker" | "local"; // where dots' computers run by default
  docker: boolean;
  image: string;
  model: string; // default model for dots without their own choice
  models: string[]; // models the API key can use
  computerTool: string;
  hasKey: boolean;
  keySource: "env" | "settings" | null;
  cloudKey: "env" | "settings" | null; // E2B key for cloud computers
  openRouter: "env" | "settings" | null; // OpenRouter key for open models
  openCode: {
    go: { source: "settings" | "cli" | "env" | null; enabled: boolean };
    zen: { source: "settings" | "cli" | "env" | null; enabled: boolean };
  };
  triggersKey: "env" | "settings" | null; // Composio API key for triggers
  sky: boolean; // OpenAI's Sky computer-use runtime is installed on this Mac
  composio: boolean; // COMPOSIO_API_KEY is set
};

export type ServerEvent =
  | { type: "snapshot"; data: Snapshot }
  | { type: "dot"; data: Dot }
  | { type: "dot_deleted"; id: string }
  | { type: "message"; data: Message }
  | { type: "message_delta"; id: string; dotId: string; delta: string }
  | { type: "routine"; data: Routine }
  | { type: "routine_deleted"; id: string }
  | { type: "trigger"; data: AppTrigger }
  | { type: "trigger_deleted"; id: string }
  | { type: "rule"; data: Rule }
  | { type: "rule_deleted"; id: string }
  | { type: "memory"; data: Memory }
  | { type: "memory_deleted"; id: string }
  | { type: "skill"; data: Skill }
  | { type: "skill_deleted"; id: string }
  | { type: "password"; data: PasswordEntry }
  | { type: "password_deleted"; id: string }
  | { type: "screen"; dotId: string; at: number }
  | { type: "browser_url"; dotId: string; url: string }
  | { type: "notify"; dotId: string; title: string; body: string }
  | { type: "computer"; data: ComputerInfo }
  | { type: "composio"; data: ToolkitState[] }
  | { type: "channel"; data: Channel }
  | { type: "channel_deleted"; id: string }
  | { type: "conversation"; data: Conversation }
  | { type: "conversation_deleted"; id: string };
