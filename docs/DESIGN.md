# UI conventions

One place for the rules that keep the dashboard consistent. If a change makes a
screen disagree with this file, the screen is wrong.

## Typography

- Inter throughout, via `--font-sans`. Headings use `tracking-tighter`.
- **The mono font is only for text that is literally code.** That means: the
  message body editor (it holds spintax, the `{a|b}` syntax that varies a
  message), the proxy URL field, raw CSV lines we could not parse, and `<code>`
  spans inside help text. Fields where the user types a bare identifier (a phone
  number, a country code) may keep it, because digit alignment while typing is
  genuinely useful.
- Everything else uses the app font, including every number. Counts, rates, phone
  numbers in tables, stat values and status chips get `tabular-nums` instead.
  Mono on read-only data made the dashboard look like a terminal.
- Body copy is `text-sm`, helper text `text-xs text-muted-foreground`.

## Spacing

- `space-y-4` between cards, `gap-3` inside a grid, `gap-2` between controls in a
  row. Sections are full width: no `max-w-*` that leaves an empty gutter.
- Numeric table cells are right-aligned with `tabular-nums`.

## Radius and elevation

`--radius` is `0.375rem`, and every other radius is derived from it: `--radius-md`
is 80% of it, `--radius-4xl` is 2.6× it, and so on up and down the scale. Do not
hard-code a radius on a component; change the token if the whole app should move.
The shadcn defaults pinned cards and dialogs to `rounded-[min(var(--radius-4xl),24px)]`,
which ignored the token, so those were normalised to `rounded-md`.

**No shadows.** Separation comes from borders, everywhere, including floating
surfaces: dialogs, dropdowns, selects, sheets and the chart tooltip all use the
`border` token rather than an elevation or a faint ring. If a surface looks like
it is floating without a border, give it a border, not a shadow.

## Forms and dialogs

- Every field is a shadcn `Field` with a `FieldLabel` and, where it needs one, a
  `FieldDescription` **below the control** rather than beside the label.
- **A label must not wrap.** If it does, the label is too long or the column is
  too narrow. Shorten the label and move the detail into the description.
- Settings rows are at most two columns on desktop (`sm:grid-cols-2`). Four
  columns of long labels wrap into an unreadable stack.
- Tooltips are for meaning a label cannot carry: a metric whose definition is not
  obvious, a term borrowed from somewhere else, a setting with a consequence. One
  plain sentence.

**Do not put a tooltip on a control that explains itself.** A button labelled Pause,
Delete, Test, Start or Save needs no hover text saying it pauses, deletes, tests,
starts or saves. Neither does a column headed Name or Sent. A tooltip on every
element is noise, it fires while you are reading the thing underneath it, and it
trains people to ignore the ones that matter. If a label needs explaining, first try
writing a better label.

## Feedback

- **No spinners.** A busy button keeps its icon and changes its label to
  "Sending…", "Saving…", "Importing…". A loading pane says "Loading contacts…".
- Toasts are the neutral popover surface. No `richColors`, no green or red fills.
- Never `alert()` or `confirm()`. Destructive actions go through `ConfirmButton`.

## Tables

Every table is `components/data-table/`. The TanStack v9 details live in
[Contributing to the UI](../README.md#contributing-to-the-ui).

## Chrome

Keep it minimal. There is no page footer: it added a line of chrome to every
screen and repeated what the README already says. The sidebar wordmark is text,
not a logo mark, and it sits on the same left edge as the nav items below it.

## Copy

- No em dashes in user-visible text. Use a period, comma, colon or parentheses.
- Sentence case, short, plain. A layperson must understand every label, and any
  unavoidable jargon is explained in its tooltip.
- Never imply that ramping up a number builds reputation or trust with WhatsApp.
