<template>
  <div v-loading="loading">
    <el-alert
      title="治理口径：县级看到的不只是数量销号，更关注高风险房屋是否真正停用、整改是否按方案逐项完成、补助是否发给符合条件家庭。"
      type="info" show-icon :closable="false" style="margin-bottom:14px" />

    <el-row :gutter="14">
      <el-col :span="6"><div class="kpi"><div class="num">{{ d.totalHouses }}</div><div class="k">建档房屋总数</div></div></el-col>
      <el-col :span="6"><div class="kpi warn"><div class="num">{{ d.highRisk }}</div><div class="k">暂停使用+紧急转移（高风险）</div></div></el-col>
      <el-col :span="6"><div class="kpi danger"><div class="num">{{ Math.round((d.highRiskStopRate || 0) * 100) }}%</div><div class="k">高风险已停用/处置率（{{ d.highRiskStopped }}/{{ d.highRisk }}）</div></div></el-col>
      <el-col :span="6"><div class="kpi ok"><div class="num">{{ Math.round((d.closureRate || 0) * 100) }}%</div><div class="k">销号率（{{ d.closed }}/{{ d.totalHouses }}，反弹 {{ d.rebound }}）</div></div></el-col>
    </el-row>

    <el-alert
      v-if="d.notStoppedHouses?.length"
      :title="`高风险尚未真正停用（${d.notStoppedHouses.length}栋）——存在人员继续居住/经营风险，需立即督办`"
      type="error" show-icon :closable="false" style="margin:14px 0" />
    <el-table v-if="d.notStoppedHouses?.length" :data="d.notStoppedHouses" size="small" style="margin-bottom:14px" border>
      <el-table-column prop="code" label="档案号" width="150" />
      <el-table-column prop="township" label="乡镇" width="100" />
      <el-table-column prop="village" label="村" width="120" />
      <el-table-column prop="ownerName" label="户主" width="100" />
      <el-table-column label="风险" width="110">
        <template #default="{ row }"><el-tag size="small" :type="RISK[row.riskLevel].type">{{ RISK[row.riskLevel].label }}</el-tag></template>
      </el-table-column>
      <el-table-column label="当前状态">
        <template #default="{ row }"><el-tag size="small" :type="STATUS[row.status]?.type">{{ STATUS[row.status]?.label }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }"><el-button link type="primary" @click="$router.push(`/houses/${row.id}`)">进档案督办</el-button></template>
      </el-table-column>
    </el-table>

    <el-row :gutter="14">
      <el-col :span="8">
        <el-card shadow="never">
          <template #header>风险等级分布</template>
          <div v-for="(v, k) in d.byRisk" :key="k" class="bar-row">
            <el-tag size="small" :type="RISK[k].type" class="bar-label">{{ RISK[k].label }}</el-tag>
            <el-progress :percentage="pct(v, d.totalHouses)" :stroke-width="16" :format="() => v + '栋'" />
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <template #header>治理环节分布</template>
          <div v-for="(v, k) in d.byStatus" :key="k" class="bar-row">
            <el-tag size="small" :type="(STATUS[k]||{}).type || 'info'" class="bar-label">{{ (STATUS[k]||{}).label || k }}</el-tag>
            <el-progress :percentage="pct(v, d.totalHouses)" :stroke-width="16" :status="k==='REBOUND'?'exception':k==='CLOSED'?'success':''" :format="() => v + '栋'" />
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <template #header>补助发放监督</template>
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="资格校验未过/补材料">{{ d.subsidySummary?.draft }}</el-descriptions-item>
            <el-descriptions-item label="待乡镇复核">{{ d.subsidySummary?.submitted }}</el-descriptions-item>
            <el-descriptions-item label="已批准（待销号后发）">{{ d.subsidySummary?.approved }}</el-descriptions-item>
            <el-descriptions-item label="已驳回">{{ d.subsidySummary?.rejected }}</el-descriptions-item>
            <el-descriptions-item label="已发放">{{ d.subsidySummary?.paid }} 户</el-descriptions-item>
            <el-descriptions-item label="累计发放金额"><b class="money">¥{{ (d.subsidySummary?.paidAmount || 0).toLocaleString() }}</b></el-descriptions-item>
          </el-descriptions>
          <div class="section-hint">补助仅在验收销号后发放，防止“带病拨款”；存在资格争议未办结的不得批准。</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="14" style="margin-top:14px">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>分乡镇治理进度</template>
          <el-table :data="townshipRows" size="small" border>
            <el-table-column prop="township" label="乡镇" />
            <el-table-column prop="total" label="建档" width="70" align="center" />
            <el-table-column prop="highRisk" label="高风险" width="80" align="center" />
            <el-table-column label="销号率" width="120">
              <template #default="{ row }">{{ row.total ? Math.round(row.closed / row.total * 100) : 0 }}%（{{ row.closed }}）</template>
            </el-table-column>
            <el-table-column label="反弹" width="70" align="center">
              <template #default="{ row }"><el-tag size="small" :type="row.rebound ? 'danger' : 'success'">{{ row.rebound }}</el-tag></template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>基层协商成本：异常事件处置（8类）</template>
          <el-table :data="issueRows" size="small" border>
            <el-table-column label="异常类型">
              <template #default="{ row }">{{ ISSUE_TYPES[row.k] }}</template>
            </el-table-column>
            <el-table-column label="未办结" width="90" align="center">
              <template #default="{ row }"><el-tag size="small" :type="row.open ? 'danger' : 'info'">{{ row.open }}</el-tag></template>
            </el-table-column>
            <el-table-column label="已办结" width="90" align="center">
              <template #default="{ row }">{{ row.resolved }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" style="margin-top:14px">
      <template #header>
        <div class="card-h">
          <span>连续暴雨后复核处置（风险事件 · 同一处置任务 · 困难家庭双通道）</span>
          <el-button link type="primary" @click="$router.push('/rain')">进雨后复核台 →</el-button>
        </div>
      </template>
      <el-row :gutter="14">
        <el-col :span="8">
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="雨后风险事件总数">{{ d.rainSummary?.total ?? 0 }} 起</el-descriptions-item>
            <el-descriptions-item label="待处置决定">
              <el-tag size="small" type="danger">{{ d.rainSummary?.open ?? 0 }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="处置中·待复查">
              <el-tag size="small" type="warning">{{ d.rainSummary?.disposing ?? 0 }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="复查合格已关闭">{{ d.rainSummary?.restored ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="决定先转移（三方任务）">{{ d.rainSummary?.evacuate ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="72小时内反复上报升级">{{ d.rainSummary?.repeated ?? 0 }} 起</el-descriptions-item>
          </el-descriptions>
        </el-col>
        <el-col :span="8">
          <div class="bar-row"><b>同一处置任务落实情况</b></div>
          <div v-for="r in (d.rainTaskByRole || [])" :key="r.role" class="bar-row">
            <el-tag size="small" :class="'t-'+r.role" class="bar-label">{{ r.label }}</el-tag>
            <el-progress :percentage="r.total ? Math.round(r.done / r.total * 100) : 0" :stroke-width="15"
              :status="r.done === r.total ? 'success' : ''"
              :format="() => `${r.done}/${r.total} 已办结`" />
          </div>
          <div class="section-hint">村干部、住建、民政收到的是同一风险事件下的同一条处置任务，处置结果回写同一档案。</div>
        </el-col>
        <el-col :span="8">
          <div class="bar-row"><b>困难家庭救助双通道</b></div>
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="涉及困难家庭事件">{{ d.rainSummary?.difficult ?? 0 }} 起</el-descriptions-item>
            <el-descriptions-item label="临时安置救助已发放">{{ d.emergencySummary?.paid ?? 0 }} 户 / ¥{{ (d.emergencySummary?.paidAmount || 0).toLocaleString() }}</el-descriptions-item>
            <el-descriptions-item label="应急救助待复核/已批准">{{ (d.emergencySummary?.submitted ?? 0) + (d.emergencySummary?.approved ?? 0) }} 户</el-descriptions-item>
          </el-descriptions>
          <div class="section-hint">临时安置救助民政安置任务落实后即发；修缮补助仍须复查合格销号后发放。</div>
        </el-col>
      </el-row>
    </el-card>

    <el-card shadow="never" style="margin-top:14px">
      <template #header>整改措施完成情况（按整改项）</template>
      <el-row :gutter="10">
        <el-col v-for="(v, k) in d.itemByType" :key="k" :span="8" style="margin-bottom:10px">
          <div class="bar-row">
            <span class="bar-text">{{ ITEM_TYPES[k] }}</span>
            <el-progress :percentage="v.total ? Math.round(v.done / v.total * 100) : 0" :stroke-width="14"
              :status="v.failed ? 'exception' : 'success'"
              :format="() => `${v.done}/${v.total}${v.failed ? ` 不合格${v.failed}` : ''}`" />
          </div>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import http from '../api';
import { RISK, STATUS, ISSUE_TYPES, ITEM_TYPES } from '../labels';

const d = ref({});
const loading = ref(false);
const pct = (v, t) => (t ? Math.round((v / t) * 100) : 0);
const townshipRows = computed(() => Object.entries(d.value.byTownship || {}).map(([township, v]) => ({ township, ...v })));
const issueRows = computed(() => Object.entries(d.value.issuesByType || {}).map(([k, v]) => ({ k, ...v })));

onMounted(async () => {
  loading.value = true;
  try {
    const { data } = await http.get('/api/dashboard');
    d.value = data;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.kpi { background:#fff; border-radius:10px; padding:18px 20px; border-left:5px solid #2f6fb3; }
.kpi.warn { border-color:#e6a23c; } .kpi.danger { border-color:#f56c6c; } .kpi.ok { border-color:#67c23a; }
.kpi .num { font-size:30px; font-weight:700; color:#1f2d3d; }
.kpi .k { color:#7a8899; font-size:13px; margin-top:4px; }
.bar-row { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.bar-label { width:78px; flex:none; text-align:center; }
.bar-text { width:110px; flex:none; font-size:13px; color:#445; }
.money { color:#f56c6c; }
.card-h { display:flex; justify-content:space-between; align-items:center; }
.t-CADRE_URGENT { background:#e6a23c; border-color:#e6a23c; color:#fff; }
.t-CIVIL_AFFAIRS { background:#67c23a; border-color:#67c23a; color:#fff; }
</style>
