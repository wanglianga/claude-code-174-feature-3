<template>
  <div v-loading="loading">
    <el-page-header @back="$router.back()" class="ph" content="房屋安全档案">
      <template #content>
        <span style="font-weight:700">房屋安全档案</span>
        <el-tag style="margin-left:10px">{{ a.house?.code }}</el-tag>
      </template>
    </el-page-header>

    <el-card shadow="never" class="head-card" v-if="a.house">
      <div class="hgrid">
        <div>
          <div class="h1">
            {{ a.house.ownerName }}
            <el-tag :type="RISK[a.house.riskLevel].type" effect="dark" size="large">{{ RISK[a.house.riskLevel].label }}</el-tag>
            <el-tag :type="STATUS[a.house.status]?.type" size="large">{{ STATUS[a.house.status]?.label }}</el-tag>
            <el-tag v-if="a.house.stopUseConfirmed" type="danger" effect="plain">已封停</el-tag>
          </div>
          <div class="h2">{{ a.house.township }} · {{ a.house.village }} · {{ a.house.address }}</div>
          <div class="h3">
            {{ a.house.buildYear }}年建 · {{ a.house.floors }}层 · 用途：{{ a.house.usage }} · 居住{{ a.house.residents }}人
            <el-tag v-if="a.house.isBusiness" size="small" type="warning" effect="plain">经营</el-tag>
            <el-tag v-if="a.house.isRented" size="small" type="warning" effect="plain">出租</el-tag>
            <el-tag v-if="a.house.isAddedFloor" size="small" type="danger" effect="plain">加层</el-tag>
          </div>
        </div>
        <div class="reasons">
          <div class="rt">风险判定依据（规则引擎）</div>
          <el-text v-for="(r,i) in a.house.ruleReasons" :key="i" tag="div" size="small">· {{ r }}</el-text>
        </div>
      </div>
      <el-alert v-if="a.blockingIssues?.length" type="error" show-icon :closable="false" style="margin-top:12px"
        :title="`存在 ${a.blockingIssues.length} 件阻断性问题未办结，相关环节被冻结：${a.blockingIssues.map(x=>ISSUE_TYPES[x.type]).join('、')}`" />
    </el-card>

    <el-card shadow="never" style="margin-top:12px">
      <el-tabs v-model="tab">
        <el-tab-pane label="档案时间线" name="timeline">
          <el-timeline class="tl">
            <el-timeline-item v-for="x in a.activities" :key="x.id" :timestamp="fmtDate(x.createdAt)" placement="top"
              :type="kindType(x.kind)">
              <el-card shadow="hover" class="tl-card">
                <div class="tl-title"><el-tag size="small" :type="kindType(x.kind)">{{ ACTIVITY_KIND[x.kind] || x.kind }}</el-tag> {{ x.title }} <span class="op">{{ x.operatorName }}</span></div>
                <div v-if="x.detail" class="tl-detail">{{ x.detail }}</div>
              </el-card>
            </el-timeline-item>
          </el-timeline>
        </el-tab-pane>

        <el-tab-pane label="复核与整改方案" name="review">
          <tab-review :archive="a" @reload="load" />
        </el-tab-pane>

        <el-tab-pane label="告知 · 停用 · 转移" name="notice">
          <tab-notice :archive="a" @reload="load" />
        </el-tab-pane>

        <el-tab-pane label="多方协商 · 异常" name="issues">
          <tab-issues :archive="a" @reload="load" />
        </el-tab-pane>

        <el-tab-pane :label="rainTabLabel" name="rain">
          <tab-rain :archive="a" @reload="load" />
        </el-tab-pane>

        <el-tab-pane label="家庭 · 施工" name="build">
          <tab-construction :archive="a" @reload="load" />
        </el-tab-pane>

        <el-tab-pane label="补助" name="subsidy">
          <tab-subsidy :archive="a" @reload="load" />
        </el-tab-pane>

        <el-tab-pane label="验收 · 销号 · 复查" name="accept">
          <tab-acceptance :archive="a" @reload="load" />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import http from '../api';
import { RISK, STATUS, ISSUE_TYPES, ACTIVITY_KIND, fmtDate } from '../labels';
import TabReview from '../components/TabReview.vue';
import TabNotice from '../components/TabNotice.vue';
import TabIssues from '../components/TabIssues.vue';
import TabRain from '../components/TabRain.vue';
import TabConstruction from '../components/TabConstruction.vue';
import TabSubsidy from '../components/TabSubsidy.vue';
import TabAcceptance from '../components/TabAcceptance.vue';

const route = useRoute();
const a = ref({});
const loading = ref(false);
const tab = ref('timeline');

const openRainCount = computed(
  () => (a.value.rainEvents || []).filter((e) => e.status !== 'RESTORED').length,
);
const rainTabLabel = computed(() => (openRainCount.value ? `雨后风险事件（${openRainCount.value}）` : '雨后风险事件'));

function kindType(k) {
  return {
    INSPECTION: 'primary', REVIEW: 'primary', NOTICE: 'warning', EVACUATE: 'danger',
    PLAN: 'primary', SUBSIDY: 'warning', MATERIAL: 'danger', CONSTRUCTION: '',
    ACCEPTANCE: 'success', CLOSE: 'success', RECHECK: 'warning', ISSUE: 'danger', CONSULT: 'info',
  }[k] || '';
}
async function load() {
  loading.value = true;
  try {
    const { data } = await http.get(`/api/houses/${route.params.id}/archive`);
    a.value = data;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(() => route.params.id, load);
</script>

<style scoped>
.ph { margin-bottom:10px; }
.head-card { border-top:3px solid #2f6fb3; }
.hgrid { display:flex; justify-content:space-between; gap:24px; }
.h1 { font-size:19px; font-weight:700; display:flex; gap:8px; align-items:center; }
.h2 { color:#445; margin:6px 0; }
.h3 { color:#7a8899; font-size:13px; display:flex; gap:4px; flex-wrap:wrap; align-items:center; }
.reasons { min-width:300px; max-width:420px; background:#f7f9fc; border-radius:8px; padding:10px 14px; }
.rt { font-weight:600; margin-bottom:6px; color:#445; font-size:13px; }
.tl-card { padding:6px 12px; }
.tl-title { font-weight:600; font-size:13.5px; }
.tl-detail { color:#6b7888; font-size:12.5px; margin-top:4px; }
.op { color:#9aa7b5; font-weight:400; font-size:12px; margin-left:6px; }
</style>
