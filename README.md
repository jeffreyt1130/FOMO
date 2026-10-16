# FOMO

Every UCL society event in one feed, a live map, friends, snaps and votes. Built for the UCL "enhance student life" hackathon.

**Live site:** https://jeffreyt1130.github.io/FOMO/

## How it works

- Static site hosted on GitHub Pages (`index.html` plus map tiles in `tiles/`).
- Accounts, shared data, live updates and photo storage come from Supabase (`web-adapter.js`).
- Access rules are enforced in the database (`supabase/1-setup.sql`):
  - Anyone can read events and societies.
  - People can only change their own profile, "going" list, votes and snaps.
  - Admins (emails listed in the `admins` table) manage events, societies and committee approvals.
- Events come from the Students' Union UCL What's On listings (`supabase/2-data-*.sql`).

## Setting up a fresh copy

1. In a new Supabase project, run these in the SQL Editor:
   - `supabase/1-setup.sql`, with your admin email on the last line
   - then both `supabase/2-data-*.sql` files
2. In Supabase, go to Authentication → Email and turn off "Confirm email".
3. In `index.html`, put your project URL and anon key in `window.FOMO_CONFIG`.
4. In the GitHub repo, go to Settings → Pages → Deploy from branch `main`, folder `/ (root)`.
