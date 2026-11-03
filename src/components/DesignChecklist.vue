<script setup>
defineProps({
  items: { type: Array, required: true },
});

// Issues marked "figma" are mistakes in the design file; they don't count against the site.
const siteIssues = (c) => (c.issues || []).filter((i) => i.source !== 'figma').length;

const ASPECTS = {
  Typography: 'family, size, weight, line height, letter spacing, transform',
  Colors: 'text, background, border, accents',
  Spacing: 'padding, margins, gaps',
  'Sizing & shape': 'widths, heights, radius, borders',
  Copy: 'text matches the design',
};
</script>

<template>
  <ul class="checklist design-checklist">
    <li v-for="c in items" :key="c.category" :class="c.passed ? 'pass' : 'fail'">
      <span class="mark" :aria-label="c.passed ? 'Follows the design' : 'Does not follow the design'">
        <svg v-if="c.passed" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg>
        <svg v-else viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </span>
      <div class="row-body">
        <div class="item">
          {{ c.category }}
          <span class="aspects">{{ ASPECTS[c.category] }}</span>
        </div>
        <ul v-if="c.issues?.length" class="issues">
          <li v-for="(issue, i) in c.issues" :key="i" :class="{ 'figma-issue': issue.source === 'figma' }">
            <span v-if="issue.source === 'figma'" class="issue-figma" title="Looks like a mistake in the Figma file, not on the site. Raise it with the designer instead of changing code.">Fix in Figma</span>
            <span v-if="issue.section" class="issue-section">{{ issue.section }}</span>
            {{ issue.issue }}
          </li>
        </ul>
      </div>
      <div class="row-tags">
        <span class="tag">{{ c.passed ? 'followed' : `${siteIssues(c)} issue${siteIssues(c) === 1 ? '' : 's'}` }}</span>
      </div>
    </li>
  </ul>
</template>
