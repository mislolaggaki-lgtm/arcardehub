// In-game update log. Newest first. Loaded by index.html (changelog popup)
// and by the server (the weekly email always features UPDATES[0]).
const UPDATES = [
  {
    version: '2.0', date: 'June 2026', title: 'GAMING AI, NEW NAV & ACCOUNT SECURITY',
    changes: [
      'Gaming AI — full-screen Siri-style AI assistant powered by Groq. Knows everything about ArcadeHub: weapons, biomes, bosses, enemies, potions, attachments, cosmetics and more',
      'Ask the AI anything about the game — strategies, item stats, boss tips, lore',
      'AI refuses questions about other games but answers general knowledge freely',
      'Spinning logo animation while the AI is thinking; large centered logo when chat is empty',
      'New dropdown navigation — the main menu is now a single button on both desktop and mobile, containing all sections (Shop, Leaderboard, AI, Friends, etc.)',
      'LOGIN button and ONLINE counter remain always visible outside the dropdown',
      'Email verification — new accounts must verify their email with a 6-digit code before logging in',
      'Password reset — forgot your password? Request a reset code sent to your email',
      'Accounts without a linked email are prompted to add one after login',
      'Admin panel — Stotch can view all registered accounts, see emails and verification status, delete accounts, and manage Bucks',
      'Spam folder reminder shown on all email code screens',
      'Email verified column in admin panel now correctly reflects real verification state',
    ]
  },
  {
    version: '1.9', date: 'May 2026', title: 'KILL SOUND, HONORED ONE & FIXES',
    changes: [
      'New SPECIAL tab in the Shop — unlocks unique features beyond cosmetics',
      'Kill Sound (1000 B$): upload a 1–5 second audio or video clip that plays whenever you kill a player in PvP — fades out when you respawn. Change it any time for 200 B$',
      'New Legendary emote: Honored One — your avatar rises 2.4 units into the air in a dramatic floating pose, arms spread wide, body tilted back, for 6 seconds',
      'Epic Speed Boots (Purple) added to the Shop',
      'Wings taunt text updated to correctly read "Fly time extended"',
      'Passive bonus for Wings and Speed Boots corrected to +2/+4/+6/+8s by rarity (Common/Rare/Epic/Legendary)',
      'Speed Boots description now shows the rarity-based bonus in the shop card',
    ]
  },
  {
    version: '1.8', date: 'May 2026', title: 'BIOME ROBOTS, SHOP & PASSIVE GEAR',
    changes: [
      'Robots now change colour to match their biome — ice-blue in Ice Tundra, fiery red in Lava Forge, toxic green in Toxic Swamp, and a unique tint for all 27 biomes',
      'New Speed Boots item in the Shop (Common / Rare / Legendary) — cosmetic feet item',
      'Equipping Wings extends all flying potions: +1s (Rare), +2s (Epic), +3s (Legendary)',
      'Equipping Speed Boots extends the Speed potion: +1s (Common), +2s (Rare), +3s (Legendary)',
      'Bonus seconds are shown in the kill-feed message when a potion is picked up',
      'Effect bar duration now reflects the actual bonus-extended duration',
      'Phantom robots now begin appearing at level 50 instead of level 75',
      'Level 65 and above: robot mode (Melee / Shooter / Phantom) is picked at random each level',
    ]
  },
  {
    version: '1.7', date: 'May 2026', title: 'BOSS LEVELS & BIGGER ARENA',
    changes: [
      'Arena is 95% larger — nearly double the width and depth of the previous map',
      'Boss levels every 100 levels (100, 200, … 1000) — 10 boss tiers total',
      'Boss robot is 3× the size of a normal enemy — same model, massively scaled up',
      'Boss switches between Melee, Shooter and Phantom modes as its HP drops',
      'Boss arena is stripped to 4 symmetric walls — wide-open fight with nowhere to hide',
      'Boss levels always take place in the FACILITY biome regardless of progression',
      'Defeating a boss rewards +75 HP instead of the usual +25',
      'A "⚠ WARNING — BOSS LEVEL" intro card appears before each boss encounter',
      '"BOSS DEFEATED — TIER X ELIMINATED" screen replaces the normal Room Cleared card',
      'Level cap raised from 100 to 1000 — reaching level 1000 now shows the true victory screen',
    ]
  },
  {
    version: '1.6', date: 'May 2026', title: 'BIOMES, SOUND & PARTICLES',
    changes: [
      '7 biomes — Normal, Ice, Lava, Forest, Desert, Cyber, Void — cycling every 5 levels',
      'Each biome has a unique floor texture, sky colour, ambient particles, and lighting',
      'Animated ambient particles: snowflakes, embers, falling leaves, sand, starfield',
      'Unique procedural sound per weapon — every gun sounds distinct',
      'Footstep sounds change per biome surface (crunch on ice, sizzle on lava, rustle on grass…)',
      'Spatial 3D audio — hear enemy positions by direction using HRTF panning',
      'Shell casings eject and bounce on the floor when you fire',
      'Bullet impacts spawn dust clouds and leave dark marks on surfaces',
      'Robots die with a static electricity burst — arc bolts, sparks, and an electric shockwave',
      'FPS Settings accessible from the main menu: sensitivity, FOV, quality, volume, FPS counter',
    ]
  },
  {
    version: '1.5', date: 'May 2026', title: '3D SHOP AVATAR & MOBILE NAV',
    changes: [
      'Full 3D rotating robot avatar in the Shop — drag to spin it',
      'Hover any item to preview it on your robot before buying',
      'Mobile-friendly hamburger menu — all options in a slide-in drawer',
      'Purchase confirmation required for items costing 500+ Bucks',
      'Multi-select cosmetics with a one-tap Remove All button',
      'Robot no longer walks backwards toward the player in FPS Arena',
    ]
  },
  {
    version: '1.4', date: 'May 2026', title: 'LEVELS, FEEDBACK & MORE',
    changes: [
      'Each level now has a randomised wall layout — no two rooms are the same',
      'Co-op players share the exact same randomised map as the host',
      'New Feedback panel — send thoughts directly to the developer',
      'Update Log — see exactly what changed after each patch',
    ]
  },
  {
    version: '1.3', date: 'May 2026', title: 'ATTACHMENTS & SOCIAL',
    changes: [
      '54 gun-specific attachments — each built for one gun (Pistol, SMG, Minigun, Sniper)',
      'Attachments now expire after 2 lives and must be repurchased',
      'Redesigned Friends panel with status groups and profile cards',
      'Notification centre, friend requests, and status indicators',
      'Profile settings — avatar upload, bio, and username change',
      'Emote wheel customisation — equip up to 5 emotes',
    ]
  },
  {
    version: '1.2', date: 'April 2026', title: 'EMOTES & ANIMATIONS',
    changes: [
      '61 emotes — visible body animations on your robot character',
      'Robot arms, legs and torso animate per emote',
      'Mobile emote button for touch controls',
    ]
  },
  {
    version: '1.1', date: 'April 2026', title: 'GAME MODES & ARENA',
    changes: [
      'Mezzanine second floor with staircase access',
      '100-level progression with increasing bot difficulty',
      'Co-op multiplayer — play with a friend',
      'Trading system for cosmetics between players',
    ]
  },
];

if (typeof module !== 'undefined') module.exports = UPDATES;
