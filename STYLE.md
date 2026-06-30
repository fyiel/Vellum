# Code Style

#### NEVER USE ANY EM DASHES, OR DASHES OF ANY KIND!!!

## Imports & structure

- Group imports at the top, then `// section` comment before each logical block
- No blank line between a `// section` comment and the code it labels
- One blank line between sections
- One blank line between route handlers / async functions

## Functions

- `const fn = async () => {}` for standalone helpers and utilities
- `function fn()` is fine too, especially for longer named functions
- Arrow functions for short inline callbacks
- Named functions should do one thing — extract complex sub-steps (e.g. `fetchModpack` from `mcInstall`)

## Statements

- One statement per line — no semicolons joining statements on the same line
- `try { short } catch {}` is fine for error-suppression one-liners
- Short `if (cond) return value` on one line is fine when there's no body block

## Block structure

- Prefer `{}` blocks over cramming multiple things on a single line
- `if (m === 'POST') switch (action) { ... }` for routing multiple related actions
- Fallthrough `case` for grouped behaviors in switch

## Objects & data

- Use a `candidates` object + `Object.fromEntries(entries.filter(...))` for validation maps instead of flat if-assignment chains
- Template strings that get long or multiline belong in separate files (`templates/file.ext`) with `{{PLACEHOLDER}}` substitution

## Functional style

- Prefer `flatMap` / `filter` / `map` / `Object.fromEntries` over imperative loops where the intent is clear
- `Array.prototype.flatMap` to conditionally include items: `return cond ? [item] : []`
- Some `for...of` loops are fine when they make intent clearer

## Dependencies

- Prefer platform builtins: `Bun.serve`, `Bun.spawn`, `Bun.file` over npm packages
- Express (and similar) are acceptable but can be replaced by builtins when the routing is simple enough

## Blank lines inside functions

Blank lines act as paragraph separators — they mark where one logical phase ends and the next begins:

- **After a guard block**: one blank line after any early-return validation before the real work starts
- **Between distinct phases**: setup/declarations → blank → computation → blank → result/return
- **Before a final `return`**: when non-trivial computation precedes it, a blank line separates the work from the result
- **Related declarations stay together**: constants that belong to the same phase have no blank lines between them
- **Action follows setup**: `const a = ...\nconst b = ...` (no blank) then blank then the call/write/send that uses them

```ts
// example
function sanitizeSettings(raw: any) {
    if (!raw || typeof raw !== 'object') return {}   // guard

    const int = ...   // helpers — related, no blank between
    const mem = ...

    const candidates = { ... }   // computation using those helpers

    return Object.fromEntries(...)   // result
}
```

## Comments

- `// section name` to label top-level logical blocks
- Inline comments only when the WHY is non-obvious — not for what the code does
- No multi-line comment blocks or JSDoc
- Never use EM-Dashes, regular dashes, semicolons, colons, and minimize period and comma usage
- Be straightforward consize, perhaps a little ironic, casual but with said clearly with skill
- Conversational writing style (akinto: discord, twitter, etc)