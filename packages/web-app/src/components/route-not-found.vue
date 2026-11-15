<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { RouteName } from '../router';
</script>
<template>
  <main class="not-found ws-panel">
    <h1>页面不存在</h1>
    <router-link
      class="ws-button"
      :to="{ name: RouteName.starter }"
    >返回开始页面</router-link>
  </main>
</template>
<style scoped lang="less">
.not-found {
  flex: 1;
  display: grid;
  place-content: center;
  gap: 1em;
  text-align: center;
}
h1 {
  font-size: 1.4em;
  font-weight: 500;
}
a {
  color: var(--ws-blue);
  text-decoration: none;
  justify-self: center;
}
</style>
