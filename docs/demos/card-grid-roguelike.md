---
title: "Cinder Vault: Card-Grid Roguelike"
aside: false
outline: false
pageClass: demo-page
---

<script setup>
import CardGridRogueDemo from '../.vitepress/theme/components/demos/CardGridRogueDemo.vue'
import MechanismLinks from '../.vitepress/theme/components/demos/MechanismLinks.vue'

const mechanisms = [
  { title: 'Zones and card play', link: '/mechanisms/zones-and-card-play', description: 'Compose a three-action program from reusable card-like commands.' },
  { title: 'Ticks and lockstep', link: '/mechanisms/ticks-and-lockstep', description: 'Preview three beats, then resolve player and enemy intents simultaneously.' },
  { title: 'Push chains', link: '/mechanisms/push-chains', description: 'Push and pull enemies through collisions, obstacles, and chained displacement.' },
  { title: 'Gates', link: '/mechanisms/gates', description: 'Open and preserve interlocked passage state through authored gate rules.' },
  { title: 'Latched triggers', link: '/mechanisms/triggers', description: 'Turn pressure-plate entry into a stable, deterministic state transition.' },
  { title: 'Chain reactions', link: '/mechanisms/chain-reactions', description: 'Propagate barrel explosions and their damage through nearby entities.' },
]
</script>

<CardGridRogueDemo />
<MechanismLinks :items="mechanisms" />
