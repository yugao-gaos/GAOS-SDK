---
title: "Ashfall Crossing: Grid Strategy"
aside: false
outline: false
pageClass: demo-page
---

<script setup>
import GridStrategyDemo from '../.vitepress/theme/components/demos/GridStrategyDemo.vue'
import MechanismLinks from '../.vitepress/theme/components/demos/MechanismLinks.vue'

const mechanisms = [
  { title: 'Locations and layouts', link: '/mechanisms/locations-and-layouts', description: 'Address units and obstacles on a bounded axial-hex battlefield.' },
  { title: 'Ticks and lockstep', link: '/mechanisms/ticks-and-lockstep', description: 'Schedule activations by speed, recovery cost, cooldown, and deterministic tie-breaks.' },
  { title: 'Movement', link: '/mechanisms/movement', description: 'Expose legal neighboring hexes and apply movement through the same action contract.' },
  { title: 'Solver', link: '/mechanisms/solver', description: 'Rank attacks and movement options for the tactical evaluator.' },
]
</script>

<GridStrategyDemo />
<MechanismLinks :items="mechanisms" />
