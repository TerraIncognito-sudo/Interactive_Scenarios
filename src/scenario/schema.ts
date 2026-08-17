/**
 * The scenario file contract.
 *
 * This schema is the boundary between "content" and "code": everything an
 * author can express lives here, and anything that fails validation never
 * reaches the engine. Objects are strict so that a typo like `nxt:` is a
 * loud error at load time rather than a silent dead end on stage.
 */

import { z } from 'zod';

const idPattern = /^[A-Za-z0-9_-]+$/;

export const NodeIdSchema = z
  .string()
  .min(1)
  .regex(idPattern, 'ids may contain only letters, numbers, hyphens and underscores');

export const CharacterSchema = z.strictObject({
  name: z.string().min(1),
  /** Used for the nameplate and dialogue accent on the display. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a hex value like #4FC3F7')
    .default('#E0E0E0'),
  /** Portrait image, resolved relative to the scenario's assets/ folder. */
  sprite: z.string().min(1).optional(),
});

export const SceneSchema = z.strictObject({
  background: z.string().min(1).optional(),
  music: z.string().min(1).optional(),
  ambience: z.string().min(1).optional(),
});

export const LineSchema = z.strictObject({
  /** Character id. Omit for narration. */
  who: z.string().min(1).optional(),
  text: z.string().min(1),
  /** Seconds to hold this line, overriding the reading-speed estimate. */
  hold: z.number().positive().max(120).optional(),
  sfx: z.string().min(1).optional(),
});

const BaseNode = {
  id: NodeIdSchema,
  /** Switching scene re-renders background and crossfades music. */
  scene: z.string().min(1).optional(),
};

export const DialogueNodeSchema = z.strictObject({
  ...BaseNode,
  type: z.literal('dialogue'),
  lines: z.array(LineSchema).min(1),
  next: NodeIdSchema,
});

export const PollOptionSchema = z.strictObject({
  /** Short key shown on phones and used by `default`. */
  key: z.string().min(1).max(12).regex(idPattern),
  label: z.string().min(1),
  next: NodeIdSchema,
});

export const PollNodeSchema = z.strictObject({
  ...BaseNode,
  type: z.literal('poll'),
  question: z.string().min(1),
  /** Optional supporting line under the question. */
  prompt: z.string().min(1).optional(),
  /** Seconds of open voting. */
  duration: z.number().int().positive().max(3600).default(120),
  options: z.array(PollOptionSchema).min(2).max(6),
  /**
   * Option key taken when nobody votes. Required, not optional: a poll that
   * can receive zero votes must never be able to deadlock a live show.
   */
  default: z.string().min(1),
  tiebreak: z.enum(['first', 'random', 'weighted']).default('first'),
  /**
   * Writes the outcome into scenario variables that later `branch` nodes read.
   * Values may be a literal, or one of $winner / $winnerLabel / $total.
   */
  set: z.record(z.string().regex(idPattern), z.string()).optional(),
});

export const BranchConditionSchema = z.strictObject({
  if: z.string().min(1),
  next: NodeIdSchema,
});

export const BranchNodeSchema = z.strictObject({
  ...BaseNode,
  type: z.literal('branch'),
  when: z.array(BranchConditionSchema).min(1),
  /** Taken when no condition matches. Required for the same reason as poll.default. */
  else: NodeIdSchema,
});

export const PauseNodeSchema = z.strictObject({
  ...BaseNode,
  type: z.literal('pause'),
  duration: z.number().positive().max(3600),
  text: z.string().min(1).optional(),
  next: NodeIdSchema,
});

export const EndNodeSchema = z.strictObject({
  ...BaseNode,
  type: z.literal('end'),
  text: z.string().min(1).optional(),
});

export const ScenarioNodeSchema = z.discriminatedUnion('type', [
  DialogueNodeSchema,
  PollNodeSchema,
  BranchNodeSchema,
  PauseNodeSchema,
  EndNodeSchema,
]);

export const SettingsSchema = z.strictObject({
  /** Drives the automatic per-line duration estimate. */
  wordsPerMinute: z.number().int().min(40).max(600).default(160),
  minLineSeconds: z.number().positive().max(60).default(2),
  maxLineSeconds: z.number().positive().max(120).default(14),
  /** Typewriter reveal speed on the display; 0 disables the effect. */
  charsPerSecond: z.number().min(0).max(200).default(45),
});

export const ScenarioSchema = z.strictObject({
  id: z.string().min(1).regex(idPattern),
  title: z.string().min(1),
  description: z.string().optional(),
  start: NodeIdSchema,
  settings: SettingsSchema.prefault({}),
  characters: z.record(z.string().regex(idPattern), CharacterSchema).prefault({}),
  scenes: z.record(z.string().regex(idPattern), SceneSchema).prefault({}),
  nodes: z.array(ScenarioNodeSchema).min(1),
});

export type Character = z.infer<typeof CharacterSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Line = z.infer<typeof LineSchema>;
export type DialogueNode = z.infer<typeof DialogueNodeSchema>;
export type PollOption = z.infer<typeof PollOptionSchema>;
export type PollNode = z.infer<typeof PollNodeSchema>;
export type BranchNode = z.infer<typeof BranchNodeSchema>;
export type PauseNode = z.infer<typeof PauseNodeSchema>;
export type EndNode = z.infer<typeof EndNodeSchema>;
export type ScenarioNode = z.infer<typeof ScenarioNodeSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Nodes the engine can leave by following a single `next` pointer. */
export type LinearNode = DialogueNode | PauseNode;

export function isLinear(node: ScenarioNode): node is LinearNode {
  return node.type === 'dialogue' || node.type === 'pause';
}

/**
 * Estimated seconds a line should stay on screen. Explicit `hold` always wins;
 * otherwise it is reading time at the configured speed, clamped so that very
 * short lines still register and very long ones do not stall the show.
 */
export function lineDuration(line: Line, settings: Settings): number {
  if (line.hold !== undefined) return line.hold;
  const words = line.text.trim().split(/\s+/).length;
  const seconds = (words / settings.wordsPerMinute) * 60;
  return Math.min(settings.maxLineSeconds, Math.max(settings.minLineSeconds, seconds));
}
