import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Gaming AGI Open SDK',
  description: 'The open-source Game-as-a-Benchmark SDK for deterministic games, agent evaluation, and independently verifiable exact-run evidence.',
  base: '/GAOS-TurnBasedGrid-SDK/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#6657d9' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Gaming AGI Open SDK | Game-as-a-Benchmark' }],
    ['meta', {
      property: 'og:url',
      content: 'https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/',
    }],
    ['meta', {
      property: 'og:description',
      content: 'Game-as-a-Benchmark infrastructure: one product reducer for human play, agent evaluation, and independently verifiable exact-run evidence.',
    }],
    ['meta', {
      property: 'og:image',
      content: 'https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/og.png',
    }],
    ['meta', { property: 'og:image:width', content: '1731' }],
    ['meta', { property: 'og:image:height', content: '909' }],
    ['meta', {
      property: 'og:image:alt',
      content: 'Gaming AGI Open SDK: Game-as-a-Benchmark infrastructure for human play, agent evaluation, and verifiable exact runs.',
    }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'Gaming AGI Open SDK | Game-as-a-Benchmark' }],
    ['meta', {
      name: 'twitter:description',
      content: 'Game-as-a-Benchmark evaluation with deterministic execution and independently verifiable exact-run evidence.',
    }],
    ['meta', {
      name: 'twitter:image',
      content: 'https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/og.png',
    }],
    ['meta', {
      name: 'twitter:image:alt',
      content: 'Gaming AGI Open SDK: Game-as-a-Benchmark infrastructure for human play, agent evaluation, and verifiable exact runs.',
    }],
  ],
  themeConfig: {
    siteTitle: 'Gaming AGI Open SDK',
    nav: [
      { text: 'Home', link: '/' },
      {
        text: 'Why Game-as-a-Benchmark',
        items: [
          { text: 'Why Game-as-a-Benchmark', link: '/mission' },
          { text: 'What games can GAOS build?', link: '/demos/' },
          { text: 'Games built with GAOS', link: '/built-with-gaos' },
        ],
      },
      {
        text: 'Build',
        items: [
          { text: 'Quickstart', link: '/quickstart' },
          { text: 'Capabilities', link: '/capabilities' },
          { text: 'Mechanisms', link: '/mechanisms/' },
          { text: 'Real-time games', link: '/high-frequency' },
          { text: 'Agentic play', link: '/agentic-play' },
        ],
      },
      {
        text: 'About',
        items: [
          { text: 'Roadmap', link: '/roadmap' },
          { text: 'Version history', link: '/version-history' },
        ],
      },
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Why Game-as-a-Benchmark', link: '/mission' },
          { text: 'Capability map', link: '/capabilities' },
          { text: 'Quickstart', link: '/quickstart' },
          { text: 'Architecture and ownership', link: '/architecture' },
          { text: 'Real-time games', link: '/high-frequency' },
          { text: 'Terminology', link: '/terminology' },
        ],
      },
      {
        text: 'Engine',
        items: [
          { text: 'Engine boundary', link: '/engine' },
          { text: 'Mechanism overview', link: '/mechanisms/' },
            { text: 'Tick and reducer model', link: '/mechanisms/grid-model' },
          { text: 'Locations and layouts', link: '/mechanisms/locations-and-layouts' },
            { text: 'Ticks and lockstep', link: '/mechanisms/ticks-and-lockstep' },
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
          { text: 'Trust and verification', link: '/trust-and-verification' },
          { text: 'Sessions and integrity', link: '/session-and-integrity' },
          { text: 'Fixed-rate ticks', link: '/high-frequency' },
        ],
      },
      {
        text: 'Agents and integration',
        items: [
          { text: 'Agentic play', link: '/agentic-play' },
            { text: 'Tick protocol v1', link: '/protocol-v1' },
          { text: 'Python SDK surface', link: '/python' },
          { text: 'Interoperability', link: '/interoperability' },
          { text: 'Benchmark publication', link: '/benchmark-publication' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'Built with GPT-5.6 Sol', link: '/building-with-gpt-5-6-sol' },
          { text: 'Roadmap', link: '/roadmap' },
          { text: 'Support and compatibility', link: '/support' },
          { text: 'Version history', link: '/version-history' },
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
      message: 'Game-as-a-Benchmark: one product reducer for human play, agent evaluation, and verifiable exact runs.',
      copyright: 'Gaming AGI Open SDK',
    },
  },
});
