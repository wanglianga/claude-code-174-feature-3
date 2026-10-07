<template>
  <div>
    <el-alert
      title="连续暴雨后，同一房屋三天内反复上报自动合并为一条持续升级事件（等级只升不降）；事件升到转移级时村干部、住建、民政收到同一处置任务。"
      type="warning" show-icon :closable="false" style="margin-bottom:14px" />

    <el-row :gutter="14">
      <el-col :span="6"><div class="kpi danger"><div class="num">{{ stats.activeEvents ?? 0 }}</div><div class="k">持续未闭环事件</div></div></el-col>
      <el-col :span="6"><div class="kpi warn"><div class="num">{{ stats.evacuatingEvents ?? 0 }}</div><div class="k">已分流先转移事件</div></div></el-col>
      <el-col :span="6"><div class="kpi"><div class="num">{{ stats.totalReports ?? 0 }}</div><div class="k">暴雨险情上报总数（{{ stats.mergedReports ?? 0 }}次并入既有事件）</div></div></el-col>
      <el-col :span="6"><div class="kpi ok"><div class="num">{{ stats.noVisitCount ?? 0 }}</div><div class="k">系统筛除·无需重新上门</div></div></el-col>
    </el-row>

    <el-card shadow="never" style="margin-top:14px">
      <div class="filters">
        <el-select v-model="q.status" placeholder="事件状态" clearable style="width:170px" @change="load">
          <el-option v-for="(v,k) in EVENT_STATUS" :key="k" :label="v.label" :value="k" />
        </el-select>
        <el-select v-model="q.riskLevel" placeholder="风险等级" clearable style="width:140px" @change="load">
          <el-option v-for="(v,k) in RISK" :key="k" :label="v.label" :value="k" />
        </el-select>
        <el-radio-group v-model="q.active" @change="load">
          <el-radio-button value="true">仅未闭环</el-radio-button>
          <el-radio-button value="">全部</el-radio-button>
        </el-radio-group>
        <el-button type="primary" @click="load">刷新</el-button>
        <el-button v-if="canReport" type="success" @click="$router.push('/rain-report')">暴雨险情上报</el-button>
        <span class="cnt">共 {{ rows.length }} 条事件</span>
      </div>

      <el-table :data="rows" v-loading="loading" border size="small">
        <el-table-column prop="code" label="事件编号" width="120" />
        <el-table-column label="房屋" min-width="240">
          <template #default="{ row }">
            <el-link type="primary" @click.stop="$router.push(`/houses/${row.houseId}`)">{{ row.house?.code }}</el-link>
            <span> · {{ row.house?.ownerName }} · {{ row.house?.township }}{{ row.house?.village }}</span>
          </template>
        </el-table-column>
        <el-table-column label="上报次数" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.reportCount > 1 ? 'danger' : 'info'">{{ row.reportCount }} 次</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="当前风险" width="100">
          <template #default="{ row }"><el-tag size="small" :type="RISK[row.riskLevel].type">{{ RISK[row.riskLevel].label }}</el-tag></template>
        </el-table-column>
        <el-table-column label="事件状态" width="150">
          <template #default="{ row }"><el-tag size="small" :type="EVENT_STATUS[row.status]?.type">{{ EVENT_STATUS[row.status]?.label }}</el-tag></template>
        </el-table-column>
        <el-table-column label="待办任务" width="90" align="center">
          <template #default="{ row }">
            <el-badge v-if="row.pendingTasks" :value="row.pendingTasks" type="danger"><el-tag size="small">有</el-tag></el-badge>
            <el-tag v-else size="small" type="success">清零</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近上报" width="160">
          <template #default="{ row }">{{ fmtDate(row.lastReportAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="110">
          <template #default="{ row }"><el-button link type="primary" @click="$router.push(`/risk-events/${row.id}`)">处置详情</el-button></template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref, computed } from 'vue';
import http from '../api';
import { RISK, EVENT_STATUS, fmtDate } from '../labels';
import { useAuthStore } from '../store';

const auth = useAuthStore();
const canReport = computed(() => ['GRID_WORKER', 'TOWNSHIP_REVIEWER', 'COUNTY_ADMIN'].includes(auth.role));
const q = reactive({ status: '', riskLevel: '', active: 'true' });
const rows = ref([]);
const stats = ref({});
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const [ev, dash] = await Promise.all([
      http.get('/api/risk-events', { params: q }),
      http.get('/api/dashboard').catch(() => ({ data: {} })),
    ]);
    rows.value = ev.data.data;
    stats.value = dash.data.rain || {};
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<style scoped>
.kpi { background:#fff; border-radius:10px; padding:18px 20px; border-left:5px solid #2f6fb3; }
.kpi.warn { border-color:#e6a23c; } .kpi.danger { border-color:#f56c6c; } .kpi.ok { border-color:#67c23a; }
.kpi .num { font-size:28px; font-weight:700; color:#1f2d3d; }
.kpi .k { color:#7a8899; font-size:12.5px; margin-top:4px; }
.filters { display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
.cnt { color:#8a97a6; font-size:13px; margin-left:auto; }
</style>
