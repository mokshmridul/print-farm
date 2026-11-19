"use client";

import { useState } from "react";
import {
  FILAMENT_MATRIX,
  FILAMENT_MATRIX_SOURCES,
  FILAMENT_PURPOSES,
  RATING_WORDS,
  type FilamentPurpose,
  type FilamentRating,
} from "@print/shared";

/** One sequential hue (the shop's accent) mixed into the surface: more accent
 *  for a better rating. Mixing with the surface keeps the steps monotone in
 *  both themes — darker on light, brighter on dark — and capped where the
 *  cell's text keeps its contrast. */
const tint = (r: FilamentRating) => `color-mix(in oklab, var(--accent) ${r * 11}%, var(--surface))`;

function Pips({ rating }: { rating: FilamentRating }) {
  return (
    <span aria-hidden="true" className="inline-flex gap-[3px]">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`size-[7px] rounded-[2px] ${i <= rating ? "bg-text" : "bg-line"}`} />
      ))}
    </span>
  );
}

type Focus = { filament: number; purpose: FilamentPurpose } | null;

/** Which filament for what: seven filaments against seven jobs, rated 1–5.
 *  The rating is the cell's word and pips (never colour alone); hovering or
 *  focusing a cell shows the reason and the figure behind it. */
export function FilamentMatrix() {
  const [focus, setFocus] = useState<Focus>(null);
  const shown = focus ?? { filament: FILAMENT_MATRIX.length - 1, purpose: "heat" as FilamentPurpose };
  const entry = FILAMENT_MATRIX[shown.filament]!;
  const purpose = FILAMENT_PURPOSES.find((p) => p.key === shown.purpose)!;

  return (
    <section aria-labelledby="filament-matrix-title" className="mx-auto mt-14 max-w-6xl">
      <h2 id="filament-matrix-title" className="section-title text-2xl">
        Which filament for what?
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
        Seven common filaments, rated against each other for the jobs parts usually have to do.{" "}
        <span className="hidden md:inline">Point at a rating to see why.</span> Grades and brands differ, so treat it as
        a guide and mention what the part is for when you quote.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted" aria-hidden="true">
        {([1, 3, 5] as const).map((r) => (
          <span key={r} className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-md px-2 py-1" style={{ background: tint(r) }}>
              <Pips rating={r} />
            </span>
            {RATING_WORDS[r]}
          </span>
        ))}
      </div>

      {/* Wide screens: the matrix, with a reason strip under it. */}
      <div className="mt-5 hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-separate border-spacing-[2px] text-sm">
            <caption className="sr-only">
              Filaments rated 1 (poor) to 5 (excellent) for each purpose
            </caption>
            <thead>
              <tr>
                <th scope="col" className="w-40 p-2 text-left align-bottom">
                  <span className="eyebrow text-[0.7rem]">Filament</span>
                </th>
                {FILAMENT_PURPOSES.map((p) => (
                  <th key={p.key} scope="col" className="p-2 text-left align-bottom font-[650] leading-5" title={p.hint}>
                    {p.label}
                  </th>
                ))}
                <th scope="col" className="p-2 text-left align-bottom font-[650]">
                  Heat deflection
                </th>
              </tr>
            </thead>
            <tbody>
              {FILAMENT_MATRIX.map((f, fi) => (
                <tr key={f.name}>
                  <th scope="row" className="p-2 text-left align-middle">
                    <span className="block font-[650] text-text">{f.name}</span>
                    <span className="block text-xs font-[450] text-faint">{f.family}</span>
                  </th>
                  {FILAMENT_PURPOSES.map((p) => {
                    const r = f.ratings[p.key];
                    const active = shown.filament === fi && shown.purpose === p.key;
                    return (
                      <td
                        key={p.key}
                        tabIndex={0}
                        aria-label={`${f.name}, ${p.label}: ${r} of 5, ${RATING_WORDS[r]}. ${f.notes[p.key]}`}
                        onPointerEnter={() => setFocus({ filament: fi, purpose: p.key })}
                        onFocus={() => setFocus({ filament: fi, purpose: p.key })}
                        className={`cursor-default rounded-md px-2.5 py-2 align-middle outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                          active ? "ring-2 ring-[var(--text)]" : ""
                        }`}
                        style={{ background: tint(r) }}
                      >
                        <Pips rating={r} />
                        <span className="mt-1 block text-xs font-[600] text-text">{RATING_WORDS[r]}</span>
                      </td>
                    );
                  })}
                  <td className="p-2 align-middle text-xs tabular-nums text-muted">{f.heatDeflection}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="tile mt-3 p-4 text-sm leading-6" aria-live="polite">
          <span className="font-[650] text-text">
            {entry.name} · {purpose.label}: {RATING_WORDS[entry.ratings[purpose.key]]}.
          </span>{" "}
          <span className="text-muted">{entry.notes[purpose.key]}</span>{" "}
          <span className="text-faint">Best for: {entry.bestFor}</span>
        </p>
      </div>

      {/* Phones: one card per filament, every reason written out. */}
      <div className="mt-5 grid gap-3 md:hidden">
        {FILAMENT_MATRIX.map((f) => (
          <article key={f.name} className="tile p-4">
            <h3 className="font-[650] text-text">{f.name}</h3>
            <p className="text-xs text-faint">
              {f.family} · heat deflection {f.heatDeflection}
            </p>
            <dl className="mt-3 grid gap-2">
              {FILAMENT_PURPOSES.map((p) => {
                const r = f.ratings[p.key];
                return (
                  <div key={p.key} className="grid grid-cols-[7.5rem_1fr] items-start gap-3 text-sm">
                    <dt className="text-muted">{p.label}</dt>
                    <dd>
                      <span
                        className="inline-flex items-center gap-2 rounded-md px-2 py-0.5"
                        style={{ background: tint(r) }}
                        aria-label={`${r} of 5, ${RATING_WORDS[r]}`}
                      >
                        <Pips rating={r} />
                        <span className="text-xs font-[600] text-text">{RATING_WORDS[r]}</span>
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-faint">{f.notes[p.key]}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
            <p className="mt-3 text-xs leading-5 text-muted">
              <span className="font-[600] text-text">Best for:</span> {f.bestFor}
            </p>
          </article>
        ))}
      </div>

      <details className="mt-4 text-xs text-faint">
        <summary className="cursor-pointer">Sources</summary>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {FILAMENT_MATRIX_SOURCES.map((s) => (
            <li key={s.url}>
              <a href={s.url} className="underline underline-offset-2 hover:text-accent" rel="noopener noreferrer">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
