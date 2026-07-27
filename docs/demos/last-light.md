---
title: "Last Light: Real-Time Zombie Tower Defense"
aside: false
outline: false
pageClass: demo-page
---

<script setup>
import LastLightDemo from '../.vitepress/theme/components/demos/LastLightDemo.vue'
import MechanismLinks from '../.vitepress/theme/components/demos/MechanismLinks.vue'

const mechanisms = [
  { title: 'Locations and layouts', link: '/mechanisms/locations-and-layouts', description: 'Route enemies through a branching road graph with authored build sockets.' },
  { title: 'Behavior trees', link: '/mechanisms/behavior-trees', description: 'Drive wave movement, targeting priorities, and the autonomous builder policy.' },
  { title: 'Projectiles and flight', link: '/mechanisms/projectiles', description: 'Resolve rifle and area attacks against ordered targets within tower range.' },
  { title: 'Resource transactions', link: '/mechanisms/resources', description: 'Earn scrap from defeated enemies and spend it on deterministic construction.' },
  { title: 'Fixed-rate ticks', link: '/high-frequency', description: 'Advance spawning, movement, cooldowns, attacks, and waves on fixed ticks.' },
]
</script>

<LastLightDemo />
<MechanismLinks :items="mechanisms" />
