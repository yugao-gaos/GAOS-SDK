<script setup lang="ts">
import { withBase } from 'vitepress';

type MechanismLink = {
  title: string;
  link: string;
  description: string;
};

defineProps<{
  items: MechanismLink[];
}>();
</script>

<template>
  <section class="demo-mechanisms" aria-labelledby="demo-mechanisms-title">
    <header>
      <span>Under the hood</span>
      <h2 id="demo-mechanisms-title">GAOS mechanisms used</h2>
      <p>Explore the reusable SDK building blocks demonstrated by this game.</p>
    </header>
    <nav class="demo-mechanism-grid" aria-label="Mechanism documentation">
      <a v-for="item in items" :key="item.link" :href="withBase(item.link)">
        <span>{{ item.title }}</span>
        <p>{{ item.description }}</p>
        <b>Read mechanism <i>→</i></b>
      </a>
    </nav>
  </section>
</template>

<style scoped>
.demo-mechanisms {
  margin: 1.25rem 0 2rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 18px;
  padding: clamp(1.1rem, 2.5vw, 1.7rem);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--vp-c-brand-soft) 46%, transparent), transparent 58%),
    var(--vp-c-bg-soft);
}

header {
  max-width: 720px;
}

header > span {
  color: var(--vp-c-brand-1);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h2 {
  margin: 0.35rem 0 0.4rem;
  border: 0;
  padding: 0;
  color: var(--vp-c-text-1);
  font-size: clamp(1.3rem, 2.5vw, 1.75rem);
}

header p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
}

.demo-mechanism-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 0.75rem;
  margin-top: 1.2rem;
}

.demo-mechanism-grid a {
  display: flex;
  min-width: 0;
  min-height: 150px;
  flex-direction: column;
  border: 1px solid var(--vp-c-divider);
  border-radius: 13px;
  padding: 1rem;
  color: inherit;
  text-decoration: none;
  background: color-mix(in srgb, var(--vp-c-bg) 82%, transparent);
  transition: transform 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
}

.demo-mechanism-grid a:hover {
  transform: translateY(-2px);
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 12px 28px rgba(30, 25, 70, 0.12);
}

.demo-mechanism-grid a > span {
  color: var(--vp-c-text-1);
  font-size: 0.92rem;
  font-weight: 750;
}

.demo-mechanism-grid p {
  margin: 0.45rem 0 0.85rem;
  color: var(--vp-c-text-2);
  font-size: 0.76rem;
  line-height: 1.55;
}

.demo-mechanism-grid b {
  margin-top: auto;
  color: var(--vp-c-brand-1);
  font-size: 0.7rem;
  font-weight: 750;
}

.demo-mechanism-grid i {
  display: inline-block;
  margin-left: 0.2rem;
  font-style: normal;
  transition: transform 150ms ease;
}

.demo-mechanism-grid a:hover i {
  transform: translateX(3px);
}

@media (max-width: 520px) {
  .demo-mechanism-grid {
    grid-template-columns: 1fr;
  }

  .demo-mechanism-grid a {
    min-height: 0;
  }
}
</style>
