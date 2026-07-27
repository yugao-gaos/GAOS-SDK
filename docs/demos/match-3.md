---
title: "Prism Match: Match-3"
aside: false
outline: false
pageClass: demo-page
---

<script setup>
import MatchThreeDemo from '../.vitepress/theme/components/demos/MatchThreeDemo.vue'
import MechanismLinks from '../.vitepress/theme/components/demos/MechanismLinks.vue'

const mechanisms = [
  { title: 'Pattern matching', link: '/mechanisms/patterns', description: 'Find horizontal and vertical runs and turn them into deterministic legal swaps.' },
  { title: 'Chain reactions', link: '/mechanisms/chain-reactions', description: 'Resolve clears, falls, refills, and multi-stage cascades in a stable order.' },
  { title: 'Deterministic randomness', link: '/mechanisms/randomness', description: 'Reproduce authored boards and every refill from the same seed.' },
  { title: 'Solver', link: '/mechanisms/solver', description: 'Enumerate legal swaps and let the search agent rank reproducible outcomes.' },
]
</script>

<MatchThreeDemo />
<MechanismLinks :items="mechanisms" />
