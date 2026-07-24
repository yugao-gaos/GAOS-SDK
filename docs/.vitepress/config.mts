import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Gaming AGI Open SDK',
  description: 'Deterministic game mechanisms for human and AI agents.',
  base: '/GAOS-TurnBasedGrid-SDK/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#6657d9' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Gaming AGI Open SDK' }],
    ['meta', {
      property: 'og:url',
      content: 'https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/',
    }],
    ['meta', {
      property: 'og:description',
      content: 'Deterministic game mechanisms for human and AI agents.',
    }],
    ['meta', {
      property: 'og:image',
      content: 'https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/gaos-tabletop-sdk-social.png',
    }],
    ['meta', { property: 'og:image:width', content: '1730' }],
    ['meta', { property: 'og:image:height', content: '909' }],
    ['meta', {
      property: 'og:image:alt',
      content: 'Gaming AGI Open SDK — deterministic game mechanisms for humans and AI agents.',
    }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'Gaming AGI Open SDK' }],
    ['meta', {
      name: 'twitter:description',
      content: 'Deterministic game mechanisms for human and AI agents.',
    }],
    ['meta', {
      name: 'twitter:image',
      content: 'https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/gaos-tabletop-sdk-social.png',
    }],
    ['meta', {
      name: 'twitter:image:alt',
      content: 'Gaming AGI Open SDK — deterministic game mechanisms for humans and AI agents.',
    }],
  ],
  themeConfig: {
    siteTitle: 'Gaming AGI Open SDK',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Play demos', link: '/demos/' },
      {
        text: 'Build',
        items: [
          { text: 'Quickstart', link: '/quickstart' },
          { text: 'Mechanisms', link: '/mechanisms/' },
          { text: 'Agentic play', link: '/agentic-play' },
        ],
      },
      {
        text: 'About',
        items: [
          { text: 'Mission', link: '/mission' },
          { text: 'Capabilities', link: '/capabilities' },
          { text: 'Version history', link: '/version-history' },
        ],
      },
    ],
    sidebar: [
      {
        text: 'Playable demos',
        items: [
          { text: 'Demo arcade', link: '/demos/' },
          { text: 'Prism Vault — Match-3', link: '/demos/match-3' },
          { text: 'Midnight House — Blackjack', link: '/demos/blackjack' },
          { text: 'Ashfall Crossing — Strategy', link: '/demos/grid-strategy' },
          { text: 'Cinder Vault — Roguelike', link: '/demos/card-grid-roguelike' },
          { text: 'Starline Dominion — Graph RTS', link: '/demos/starline-dominion' },
          { text: 'Last Light — Zombie Defense', link: '/demos/last-light' },
        ],
      },
      {
        text: 'Start here',
        items: [
          { text: 'Mission and benchmark thesis', link: '/mission' },
          { text: 'Capability map', link: '/capabilities' },
          { text: 'Quickstart', link: '/quickstart' },
          { text: 'Architecture map', link: '/architecture' },
        ],
      },
      {
        text: 'Engine',
        items: [
          { text: 'Engine boundary', link: '/engine' },
          { text: 'Mechanism overview', link: '/mechanisms/' },
          { text: 'Turn and reducer model', link: '/mechanisms/grid-model' },
          { text: 'Locations and layouts', link: '/mechanisms/locations-and-layouts' },
          { text: 'Turn order and lockstep', link: '/mechanisms/turn-order-and-lockstep' },
          { text: 'Information partitions', link: '/mechanisms/information-partitions' },
          { text: 'Zones and card play', link: '/mechanisms/zones-and-card-play' },
          { text: 'Portals', link: '/mechanisms/portals' },
          { text: 'Pattern matching', link: '/mechanisms/patterns' },
          { text: 'Simultaneous movement', link: '/mechanisms/movement' },
          { text: 'Geometry and FOV', link: '/mechanisms/geometry' },
          { text: 'Turn settlement', link: '/settlement' },
        ],
      },
      {
        text: 'Interaction mechanisms',
        collapsed: true,
        items: [
          { text: 'Chain reactions', link: '/mechanisms/chain-reactions' },
          { text: 'Projectiles and flight', link: '/mechanisms/projectiles' },
          { text: 'Push chains', link: '/mechanisms/push-chains' },
          { text: 'Arrival rules', link: '/mechanisms/arrivals' },
          { text: 'Resource claims', link: '/mechanisms/resource-claims' },
          { text: 'Resource transactions', link: '/mechanisms/resources' },
          { text: 'Gates', link: '/mechanisms/gates' },
          { text: 'Latched triggers', link: '/mechanisms/triggers' },
          { text: 'Grid rays', link: '/mechanisms/rays' },
          { text: 'Behavior trees', link: '/mechanisms/behavior-trees' },
        ],
      },
      {
        text: 'Systems and verification',
        collapsed: true,
        items: [
          { text: 'Transport and interlocks', link: '/mechanisms/transport' },
          { text: 'Deterministic randomness', link: '/mechanisms/randomness' },
          { text: 'Scoring and AI action limits', link: '/mechanisms/scoring' },
          { text: 'Solver', link: '/mechanisms/solver' },
          { text: 'Portable replay and verification', link: '/mechanisms/replay' },
          { text: 'High-frequency turns', link: '/high-frequency' },
        ],
      },
      {
        text: 'Agents and integration',
        items: [
          { text: 'Agentic play', link: '/agentic-play' },
          { text: 'Turn protocol v1', link: '/protocol-v1' },
          { text: 'Python client', link: '/python' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'Built with GPT-5.6 Sol', link: '/building-with-gpt-5-6-sol' },
          { text: 'Support and compatibility', link: '/support' },
          { text: 'Version history', link: '/version-history' },
          { text: 'Batch implementation review', link: '/rfcs/implementation-review' },
          { text: 'Release process and migrations', link: '/releases' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK' },
      { icon: 'discord', link: 'https://discord.gg/vdvUgcqPU' },
    ],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    outline: { level: [2, 3], label: 'On this page' },
    footer: {
      message: 'Reusable mechanics in the toolkit. Product content stays in the product.',
      copyright: 'Gaming AGI Open SDK',
    },
  },
});
