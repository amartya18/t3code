#!/usr/bin/env node
/**
 * Rates for a graded memory capture trial file. A metric counts for a
 * candidate only when every grader marked it so.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";

const KINDS = ["home", "home-launched", "subagent", "normal"] as const;
type Kind = (typeof KINDS)[number];

const Grade = Schema.Struct({
  grader: Schema.String,
  true: Schema.Boolean,
  attributionCorrect: Schema.Boolean,
  worthKeeping: Schema.Boolean,
  duplicate: Schema.Boolean,
  note: Schema.optionalKey(Schema.String),
});

const GradedLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("run") }),
  Schema.Struct({
    type: Schema.Literal("candidate"),
    id: Schema.String,
    sourceThreadKind: Schema.Literals(KINDS),
    downgraded: Schema.Boolean,
    dropped: Schema.NullOr(Schema.String),
    grades: Schema.optionalKey(Schema.Array(Grade)),
  }),
]);
type GradedLine = typeof GradedLine.Type;
const decodeLine = Schema.decodeEffect(Schema.fromJsonString(GradedLine));

class GradedLineError extends Schema.TaggedError<GradedLineError>()("GradedLineError", {
  line: Schema.Int,
  detail: Schema.String,
}) {
  override get message() {
    return `line ${this.line}: ${this.detail}`;
  }
}

export const parseGradedLines = Effect.fn("parseGradedLines")(function* (text: string) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return yield* Effect.forEach(lines, (line, index) =>
    decodeLine(line).pipe(
      Effect.mapError((cause) => new GradedLineError({ line: index + 1, detail: cause.message })),
    ),
  );
});

const METRICS = ["true", "attributionCorrect", "worthKeeping", "duplicate"] as const;
type Metric = (typeof METRICS)[number];

export interface RateRow {
  readonly kind: Kind | "total";
  readonly graded: number;
  readonly ungraded: number;
  readonly true: number;
  readonly attributionCorrect: number;
  readonly worthKeeping: number;
  readonly duplicate: number;
  /** Every grader marked it not a duplicate. */
  readonly new: number;
}

export interface Rates {
  readonly rows: ReadonlyArray<RateRow>;
  readonly disagreements: Record<Metric, number>;
  readonly droppedByReason: Record<string, number>;
  readonly downgraded: number;
}

export function computeRates(lines: ReadonlyArray<GradedLine>): Rates {
  const candidates = lines.flatMap((line) => (line.type === "candidate" ? [line] : []));
  const kept = candidates.filter((line) => line.dropped === null);
  const droppedByReason: Record<string, number> = {};
  for (const line of candidates) {
    if (line.dropped !== null) {
      droppedByReason[line.dropped] = (droppedByReason[line.dropped] ?? 0) + 1;
    }
  }
  const graded = kept.flatMap((line) =>
    line.grades === undefined || line.grades.length === 0 ? [] : [line],
  );
  const all = (line: (typeof graded)[number], test: (grade: typeof Grade.Type) => boolean) =>
    line.grades!.every(test);
  const row = (kind: RateRow["kind"]): RateRow => {
    const inKind = (line: (typeof kept)[number]) =>
      kind === "total" || line.sourceThreadKind === kind;
    const rowGraded = graded.filter(inKind);
    const count = (test: (grade: typeof Grade.Type) => boolean) =>
      rowGraded.filter((line) => all(line, test)).length;
    return {
      kind,
      graded: rowGraded.length,
      ungraded: kept.filter(inKind).length - rowGraded.length,
      true: count((grade) => grade.true),
      attributionCorrect: count((grade) => grade.attributionCorrect),
      worthKeeping: count((grade) => grade.worthKeeping),
      duplicate: count((grade) => grade.duplicate),
      new: count((grade) => !grade.duplicate),
    };
  };
  const disagreements = Object.fromEntries(
    METRICS.map((metric) => [
      metric,
      graded.filter((line) => new Set(line.grades!.map((grade) => grade[metric])).size > 1).length,
    ]),
  ) as Record<Metric, number>;
  return {
    rows: [...KINDS.map(row), row("total")],
    disagreements,
    droppedByReason,
    downgraded: kept.filter((line) => line.downgraded).length,
  };
}

const COLUMNS = ["true", "attributionCorrect", "worthKeeping", "duplicate", "new"] as const;

const rate = (count: number, total: number) =>
  total === 0 ? "-" : `${count}/${total} (${Math.round((100 * count) / total)}%)`;

export function formatRates(rates: Rates): string {
  const header = ["kind", "graded", "ungraded", ...COLUMNS];
  const table = [
    header,
    ...rates.rows.map((row) => [
      row.kind,
      String(row.graded),
      String(row.ungraded),
      ...COLUMNS.map((column) => rate(row[column], row.graded)),
    ]),
  ];
  const widths = header.map((_, index) => Math.max(...table.map((cells) => cells[index]!.length)));
  const dropped = Object.entries(rates.droppedByReason).toSorted(([a], [b]) => a.localeCompare(b));
  return [
    ...table.map((cells) =>
      cells
        .map((cell, index) => cell.padEnd(widths[index]!))
        .join("  ")
        .trimEnd(),
    ),
    "",
    `Grader disagreements: ${METRICS.map((metric) => `${metric} ${rates.disagreements[metric]}`).join(", ")}`,
    `Downgraded to agent proposals: ${rates.downgraded}`,
    `Dropped by reason: ${dropped.length === 0 ? "none" : dropped.map(([reason, count]) => `${reason} ${count}`).join(", ")}`,
  ].join("\n");
}

const memoryCaptureRatesCommand = Command.make(
  "memory-capture-rates",
  {
    gradedPath: Argument.String("graded-path").pipe(
      Argument.withDescription("The trial's candidates.jsonl with grades added."),
    ),
  },
  ({ gradedPath }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lines = yield* parseGradedLines(yield* fs.readFileString(gradedPath));
      yield* Console.log(formatRates(computeRates(lines)));
    }),
).pipe(Command.withDescription("Print precision rates for a graded memory capture trial."));

if (import.meta.main) {
  Command.run(memoryCaptureRatesCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
