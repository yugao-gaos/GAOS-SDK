---
title: "Midnight House: Blackjack"
aside: false
outline: false
pageClass: demo-page
---

<script setup>
import BlackjackDemo from '../.vitepress/theme/components/demos/BlackjackDemo.vue'
import MechanismLinks from '../.vitepress/theme/components/demos/MechanismLinks.vue'

const mechanisms = [
  { title: 'Zones and card play', link: '/mechanisms/zones-and-card-play', description: 'Model the draw pile, player hand, dealer hand, and ordered card transfers.' },
  { title: 'Information partitions', link: '/mechanisms/information-partitions', description: 'Keep the dealer hole card hidden until the authoritative reveal.' },
  { title: 'Deterministic randomness', link: '/mechanisms/randomness', description: 'Shuffle and replay the complete table from a declared seed.' },
  { title: 'Turn settlement', link: '/settlement', description: 'Resolve blackjack, busts, pushes, dealer outcomes, and bankroll payouts.' },
]
</script>

<BlackjackDemo />
<MechanismLinks :items="mechanisms" />
