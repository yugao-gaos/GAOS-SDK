---
title: "Starline Dominion: Real-Time Graph RTS"
aside: false
outline: false
pageClass: demo-page
---

<script setup>
import StarlineDominionDemo from '../.vitepress/theme/components/demos/StarlineDominionDemo.vue'
import MechanismLinks from '../.vitepress/theme/components/demos/MechanismLinks.vue'

const mechanisms = [
  { title: 'Locations and layouts', link: '/mechanisms/locations-and-layouts', description: 'Represent planets and hyperlanes as a directed game graph rather than a grid.' },
  { title: 'Transport and interlocks', link: '/mechanisms/transport', description: 'Move fleets along declared connections with deterministic travel duration.' },
  { title: 'Arrival rules', link: '/mechanisms/arrivals', description: 'Settle reinforcement, combat, capture, and neutralization when fleets arrive.' },
  { title: 'Resource transactions', link: '/mechanisms/resources', description: 'Produce and spend fleet strength on owned planets at fixed ticks.' },
  { title: 'Fixed-rate ticks', link: '/high-frequency', description: 'Run production, fleets, and both commanders through one fixed-tick simulation.' },
]
</script>

<StarlineDominionDemo />
<MechanismLinks :items="mechanisms" />
