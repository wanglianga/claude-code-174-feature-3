<template>
  <div>
    <el-alert type="warning" :closable="false" show-icon style="margin-bottom:12px"
      title="本页把连续暴雨后的反复上报接回同一风险档案：同屋三天内反复上报是一条持续升级事件；正在整改的房屋不被重置，按继续原计划/延长整改/先转移分流；转移级由村干部、住建、民政三方同办。" />

    <el-card v-for="ev in archive.riskEvents" :key="ev.id" shadow="never" class="ev-card"
      :class="{ active: ev.status !== 'CLOSED' }">
      <div class="ev-head">
        <el-link type="primary" :underline="false" @click="$router.push(`/risk-events/${ev.id}`)"><b>{{ ev.code }}</b></el-link>
        <el-tag size="small" :type="RISK[ev.riskLevel].type">{{ RISK[ev.riskLevel].label }}</el-tag>
        <el-tag size="small" :type="EVENT_STATUS[ev.status]?.type">{{ EVENT_STATUS[ev.status]?.label }}</el-tag>
        <el-tag v-if="ev.triageDecision" size="small" type="warning" effect="plain">分流：{{ TRIAGE[ev.triageDecision].label }}</el-tag>
        <span class="cnt">累计上报 {{ ev.reportCount }} 次</span>
        <el-button link type="primary" style="margin-left:auto" @click="$router.push(`/risk-events/${ev.id}`)">进入处置 →</el-button>
      </div>
      <div class="sub">
        事件前：{{ RISK[ev.previousRiskLevel].label }}/{{ STATUS[ev.previousHouseStatus]?.label }}，原期限 {{ ev.deadlineSnapshot || '—' }}；
        最近上报 {{ fmtDate(ev.lastReportAt) }}
      </div>
      <div v-if="ev.status==='CLOSED'" class="closed">已闭环：{{ ev.closeNote }}（{{ fmtDate(ev.closedAt) }}）</div>
    </el-card>
    <el-empty v-if="!archive.riskEvents?.length" description="尚无暴雨风险事件" :image-size="70" />

    <el-card shadow="never" style="margin-top:12px">
      <template #header>暴雨后险情上报记录（含系统筛选无需重新上门的留痕）</template>
      <el-table :data="archive.rainReports" size="small" border>
        <el-table-column label="上报时间" width="160"><template #default="{row}">{{ fmtDate(row.reportedAt) }}</template></el-table-column>
        <el-table-column label="裂/渗/沉" width="90">
          <template #default="{row}">{{ row.wallCrack }}/{{ row.roofLeak }}/{{ row.foundationSettlement }}</template>
        </el-table-column>
        <el-table-column label="研判" width="90">
          <template #default="{row}"><el-tag size="small" :type="RISK[row.riskLevel].type">{{ RISK[row.riskLevel].label }}</el-tag></template>
        </el-table-column>
        <el-table-column label="归属" width="130">
          <template #default="{row}">
            <el-tag v-if="row.merged" size="small" type="warning">并入既有事件</el-tag>
            <el-tag v-else-if="row.eventId" size="small" type="danger">触发新事件</el-tag>
            <el-tag v-else size="small" type="info">筛选·无需上门</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="现场说明" min-width="200" />
        <el-table-column prop="reporterName" label="上报人" width="100" />
      </el-table>
      <el-button v-if="canReport" type="success" size="small" style="margin-top:8px" @click="reportAgain">暴雨险情再次上报</el-button>
    </el-card>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router';
import { RISK, STATUS, EVENT_STATUS, TRIAGE, fmtDate } from '../labels';
import { useAuthStore } from '../store';
const props = defineProps(['archive']);
const auth = useAuthStore();
const router = useRouter();
const canReport = ['GRID_WORKER', 'TOWNSHIP_REVIEWER', 'COUNTY_ADMIN'].includes(auth.role);
function reportAgain() { router.push({ path: '/rain-report', query: { houseId: props.archive.house.id } }); }
</script>
<style scoped>
.ev-card { margin-bottom:10px; }
.ev-card.active { border-left:4px solid #f56c6c; }
.ev-head { display:flex; gap:8px; align-items:center; }
.cnt { color:#8a97a6; font-size:12.5px; }
.sub { color:#7a8899; font-size:12.5px; margin-top:5px; }
.closed { color:#67a23a; font-size:12.5px; margin-top:5px; }
</style>
