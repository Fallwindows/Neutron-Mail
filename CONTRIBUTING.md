# Contributing

## Development workflow

1. Use Node.js 20 or newer.
2. Install the locked dependency tree with `npm ci`.
3. Copy `.env.example` to `.env.local` and provide local credentials.
4. Create a focused branch for the change.
5. Run `npm run check` before opening a pull request.
6. Run `npm run build` when a change affects routing, server rendering, or production behavior.

## Pull-request checklist

- Keep credentials, `.env.local`, runtime account data, and logs out of Git.
- Describe the user-visible behavior and how it was verified.
- Include screenshots for interface changes.
- Update the README or environment template when setup requirements change.
- Keep account isolation intact for all persisted user data.
- Confirm Gmail access remains incremental and that access tokens and raw messages are not persisted.

No automatic formatter is currently configured. Follow the existing TypeScript and CSS style, use two-space indentation, and treat ESLint as the repository consistency check.
