<template>
  <div v-loading="loading">
    <el-alert
      title="暴雨后复核：系统从历史裂缝、上次复查结论、整改期限、家庭困难四维筛出真正需要重新上门的房屋；同栋房屋三天内反复上报自动合并为一条持续升级的风险事件，不产生重复通知。"
      type="info" show-icon :closable="false" style="margin-bottom:14px" />

    <el-row :gutter="12">
      <el-col :span="6"><div class="kpi danger"><div class="num">{{ sum.open }}</div><div class="k">待乡镇处置决定</div></div></el-col>
      <el-col :span="6"><div class="kpi warn"><div class="num">{{ sum.disposing }}</div><div class="k">处置中·待雨后复查</div></div></el-col>
      <el-col :span="6"><div class="kpi"><div class="num">{{ sum.evacuate }}</div><div class="k">已决定先转移（三方任务）</div></div></el-col>
      <el-col :span="6"><div class="kpi ok"><div class="num">{{ sum.restored }}</div><div class="k">复查合格恢复关闭</div></div></el-col>
    </el-row>

    <el-card shadow="never" style="margin-top:14px">
      <el-tabs v-model="tab">
        <!-- 上门候选 -->
        <el-tab-pane name="candidates">
          <template #label>上门候选（{{ rows.length }}）</template>
          <div class="filters">
            <el-button v-if="canReport" type="primary" @click="openReport()">雨后现场上报</el-button>
            <el-tag v-if="canReport" type="info" effect="plain">同一房屋72小时内重复上报将并入同一事件</el-tag>
            <span class="cnt">按开放事件、筛查分值、风险等级排序</span>
          </div>
          <el-table :data="rows" size="small" border @row-contextmenu.prevent>
            <el-table-column label="房屋" min-width="190">
              <template #default="{ row }">
                <el-link type="primary" @click="$router.push(`/houses/${row.house.id}`)">{{ row.house.code }}</el-link>
                <div class="sub">{{ row.house.township }}·{{ row.house.village }} {{ row.house.ownerName }}</div>
              </template>
            </el-table-column>
            <el-table-column label="风险/状态" width="120">
              <template #default="{ row }">
                <el-tag size="small" :type="RISK[row.house.riskLevel].type">{{ RISK[row.house.riskLevel].label }}</el-tag>
                <el-tag size="small" style="margin-top:2px" :type="(STATUS[row.house.status]||{}).type">{{ (STATUS[row.house.status]||{}).label || row.house.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="筛查依据（历史裂缝/复查/期限/困难）" min-width="320">
              <template #default="{ row }">
                <el-tag v-for="(r,i) in row.reasons" :key="i" size="small" :type="r.includes('逾期')?'danger':r.includes('困难')?'warning':'info'" style="margin:2px">{{ r }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="整改期限" width="130">
              <template #default="{ row }">
                <span v-if="row.deadline">{{ row.deadline }}</span>
                <el-tag v-if="row.overdue" type="danger" size="small">已逾期</el-tag>
                <el-tag v-else-if="row.deadlineSoon" type="warning" size="small">临期</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="风险事件" width="180">
              <template #default="{ row }">
                <template v-if="row.event">
                  <el-tag size="small" :type="RAIN_EVENT_STATUS[row.event.status].type">{{ RAIN_EVENT_STATUS[row.event.status].label }}</el-tag>
                  <div class="sub">第{{ row.event.stage }}档 · 上报{{ row.event.reportCount }}次
                    <el-tag v-if="row.event.disposition" size="small" :type="RAIN_DISPOSITION[row.event.disposition].type">{{ RAIN_DISPOSITION[row.event.disposition].label }}</el-tag>
                  </div>
                </template>
                <span v-else class="sub">暂无事件</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="{ row }">
                <el-button v-if="canReport" link type="primary" @click.stop="openReport(row.house.id)">上报</el-button>
                <el-button link type="primary" @click.stop="$router.push(`/houses/${row.house.id}`)">进档案</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- 风险事件 -->
        <el-tab-pane :label="`风险事件（${events.length}）`" name="events">
          <el-radio-group v-model="evFilter" size="small" style="margin-bottom:10px" @change="loadEvents">
            <el-radio-button label="">全部</el-radio-button>
            <el-radio-button label="OPEN">待处置</el-radio-button>
            <el-radio-button label="DISPOSING">处置中</el-radio-button>
            <el-radio-button label="RESTORED">已关闭</el-radio-button>
          </el-radio-group>
          <el-table :data="events" size="small" border>
            <el-table-column label="房屋" min-width="200">
              <template #default="{ row }">
                <el-link v-if="row.house" type="primary" @click="$router.push(`/houses/${row.house.id}`)">{{ row.house.code }} {{ row.house.ownerName }}</el-link>
                <div class="sub">{{ row.house?.township }}·{{ row.house?.village }}</div>
              </template>
            </el-table-column>
            <el-table-column label="升级过程" width="120">
              <template #default="{ row }">
                <el-tag size="small" type="danger" effect="plain">{{ row.stage }}档 / {{ row.reportCount }}报</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="最高等级" width="100">
              <template #default="{ row }"><el-tag size="small" :type="RISK[row.riskLevel].type">{{ RISK[row.riskLevel].label }}</el-tag></template>
            </el-table-column>
            <el-table-column label="处置决定" width="130">
              <template #default="{ row }">
                <el-tag v-if="row.disposition" size="small" :type="RAIN_DISPOSITION[row.disposition].type">{{ RAIN_DISPOSITION[row.disposition].label }}</el-tag>
                <span v-else class="sub">未决定</span>
              </template>
            </el-table-column>
            <el-table-column label="困难家庭" width="80" align="center">
              <template #default="{ row }"><el-tag v-if="row.difficultFamily" size="small" type="warning">是</el-tag><span v-else class="sub">否</span></template>
            </el-table-column>
            <el-table-column label="事件状态" width="140">
              <template #default="{ row }"><el-tag size="small" :type="RAIN_EVENT_STATUS[row.status].type">{{ RAIN_EVENT_STATUS[row.status].label }}</el-tag></template>
            </el-table-column>
            <el-table-column label="最近上报" width="160">
              <template #default="{ row }">{{ fmtDate(row.lastReportAt) }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- 我的处置任务 -->
        <el-tab-pane :label="taskTabLabel" name="tasks" v-if="canSeeTasks">
          <el-table :data="tasks" size="small" border>
            <el-table-column label="处置任务" min-width="240">
              <template #default="{ row }">
                <b>{{ row.title }}</b>
                <div class="sub">{{ row.requirement }}</div>
              </template>
            </el-table-column>
            <el-table-column label="房屋" width="180">
              <template #default="{ row }">
                <el-link type="primary" @click="$router.push(`/houses/${row.houseId}`)">{{ row.house?.code }} {{ row.house?.ownerName }}</el-link>
              </template>
            </el-table-column>
            <el-table-column label="角色" width="90">
              <template #default="{ row }"><el-tag size="small" :type="RAIN_TASK_TYPE[row.taskType].type">{{ RAIN_TASK_TYPE[row.taskType].label }}</el-tag></template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }"><el-tag size="small" :type="RAIN_TASK_STATUS[row.status].type">{{ RAIN_TASK_STATUS[row.status].label }}</el-tag></template>
            </el-table-column>
            <el-table-column label="处置结果" min-width="200">
              <template #default="{ row }">
                <span v-if="row.result">{{ row.result }}</span>
                <el-button v-else-if="canDoTask" link type="primary" @click="finishTask(row)">填写结果并办结</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 雨后现场上报弹窗 -->
    <el-dialog v-model="reportVisible" title="暴雨后现场复核上报" width="640px">
      <el-form label-width="120px">
        <el-form-item label="目标房屋">
          <el-select v-model="reportForm.houseId" filterable placeholder="选择房屋档案" style="width:100%">
            <el-option v-for="h in houses" :key="h.id" :value="h.id"
              :label="`${h.code} ${h.ownerName}（${h.township}·${h.village}）`" />
          </el-select>
        </el-form-item>
        <el-form-item label="墙体裂缝">
          <el-radio-group v-model="reportForm.wallCrack">
            <el-radio-button :value="0">无</el-radio-button>
            <el-radio-button :value="1">明显</el-radio-button>
            <el-radio-button :value="2">严重</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="屋面渗漏">
          <el-radio-group v-model="reportForm.roofLeak">
            <el-radio-button :value="0">无</el-radio-button>
            <el-radio-button :value="1">局部</el-radio-button>
            <el-radio-button :value="2">严重</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="地基沉降">
          <el-radio-group v-model="reportForm.foundationSettlement">
            <el-radio-button :value="0">无</el-radio-button>
            <el-radio-button :value="1">明显</el-radio-button>
            <el-radio-button :value="2">严重</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="现场居住人数"><el-input-number v-model="reportForm.residents" :min="0" :max="50" /></el-form-item>
        <el-form-item label="现场情况"><el-input v-model="reportForm.notes" type="textarea" :rows="3" placeholder="裂缝发展、渗漏范围、人员状态等" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reportVisible = false">取消</el-button>
        <el-button type="primary" @click="submitReport">提交上报</el-button>
      </template>
    </el-dialog>

    <!-- 任务办结弹窗 -->
    <el-dialog v-model="taskVisible" title="处置任务办结" width="560px">
      <el-alert type="warning" :closable="false" show-icon style="margin-bottom:10px"
        :title="currentTask ? `${RAIN_TASK_TYPE[currentTask.taskType].label}：${currentTask.title}` : ''" />
      <el-input v-model="taskResult" type="textarea" :rows="4" placeholder="必须填写实际处置结果（转移人数、安置去向、管控措施等）" />
      <template #footer>
        <el-button @click="taskVisible = false">取消</el-button>
        <el-button type="primary" @click="submitTaskResult">确认办结</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import http from '../api';
import { RISK, STATUS, RAIN_EVENT_STATUS, RAIN_DISPOSITION, RAIN_TASK_TYPE, RAIN_TASK_STATUS, fmtDate } from '../labels';
import { useAuthStore } from '../store';

const auth = useAuthStore();
const loading = ref(false);
const tab = ref('candidates');
const rows = ref([]);
const events = ref([]);
const tasks = ref([]);
const houses = ref([]);
const evFilter = ref('');

const canReport = computed(() => ['GRID_WORKER', 'TOWNSHIP_REVIEWER', 'COUNTY_ADMIN'].includes(auth.role));
const canSeeTasks = computed(() => ['GRID_WORKER', 'TOWNSHIP_REVIEWER', 'COUNTY_ADMIN', 'CADRE', 'CIVIL_AFFAIRS'].includes(auth.role));
const canDoTask = computed(() => ['TOWNSHIP_REVIEWER', 'COUNTY_ADMIN', 'CADRE', 'CIVIL_AFFAIRS'].includes(auth.role));
const taskTabLabel = computed(() => {
  const map = { CADRE: '村干部转移任务', CIVIL_AFFAIRS: '民政治理任务', TOWNSHIP_REVIEWER: '住建处置任务', COUNTY_ADMIN: '处置任务总览', GRID_WORKER: '处置任务' };
  return map[auth.role] || '我的处置任务';
});

const sum = computed(() => {
  const s = { open: 0, disposing: 0, restored: 0, evacuate: 0 };
  for (const e of events.value) {
    if (e.status === 'OPEN') s.open++;
    if (e.status === 'DISPOSING') s.disposing++;
    if (e.status === 'RESTORED') s.restored++;
    if (e.disposition === 'EVACUATE') s.evacuate++;
  }
  return s;
});

async function loadCandidates() {
  loading.value = true;
  try {
    const { data } = await http.get('/api/rain/candidates');
    rows.value = data.data;
  } finally {
    loading.value = false;
  }
}
async function loadEvents() {
  const { data } = await http.get('/api/rain/events', { params: evFilter.value ? { status: evFilter.value } : {} });
  events.value = data;
}
async function loadTasks() {
  if (!canSeeTasks.value) return;
  const { data } = await http.get('/api/rain/tasks/mine');
  tasks.value = data;
}

const reportVisible = ref(false);
const reportForm = reactive({ houseId: '', wallCrack: 1, roofLeak: 1, foundationSettlement: 0, residents: 0, notes: '' });
function openReport(houseId) {
  reportForm.houseId = houseId || '';
  reportForm.wallCrack = 1; reportForm.roofLeak = 1; reportForm.foundationSettlement = 0; reportForm.residents = 0; reportForm.notes = '';
  reportVisible.value = true;
}
async function submitReport() {
  if (!reportForm.houseId) return ElMessage.warning('请选择目标房屋');
  const { data } = await http.post('/api/rain/reports', reportForm);
  ElMessage.success(
    data.merged
      ? `已并入同一风险事件（第${data.event.stage}档）${data.escalated ? `，风险升级为${({ NORMAL: '一般关注', RECTIFY: '限期整改', SUSPEND: '暂停使用', EVACUATE: '紧急转移' })[data.event.riskLevel]}` : ''}`
      : `新建风险事件，当前等级：${({ NORMAL: '一般关注', RECTIFY: '限期整改', SUSPEND: '暂停使用', EVACUATE: '紧急转移' })[data.event.riskLevel]}`,
  );
  reportVisible.value = false;
  await Promise.all([loadCandidates(), loadEvents()]);
  tab.value = 'events';
}

const taskVisible = ref(false);
const taskResult = ref('');
const currentTask = ref(null);
function finishTask(row) {
  currentTask.value = row;
  taskResult.value = '';
  taskVisible.value = true;
}
async function submitTaskResult() {
  if (!taskResult.value.trim()) return ElMessage.warning('处置任务办结必须填写处置结果');
  await http.post('/api/rain/tasks/complete', { taskId: currentTask.value.id, result: taskResult.value });
  ElMessage.success('任务已办结');
  taskVisible.value = false;
  await loadTasks();
}

onMounted(async () => {
  await Promise.all([loadCandidates(), loadEvents(), loadTasks()]);
  const { data } = await http.get('/api/houses', { params: { limit: 500 } });
  houses.value = data.data;
});
</script>

<style scoped>
.kpi { background:#fff; border-radius:10px; padding:16px 18px; border-left:5px solid #2f6fb3; }
.kpi.warn { border-color:#e6a23c; } .kpi.danger { border-color:#f56c6c; } .kpi.ok { border-color:#67c23a; }
.kpi .num { font-size:28px; font-weight:700; color:#1f2d3d; }
.kpi .k { color:#7a8899; font-size:13px; margin-top:4px; }
.filters { display:flex; gap:10px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
.cnt { color:#8a97a6; font-size:12px; margin-left:auto; }
.sub { color:#8a97a6; font-size:12px; line-height:1.5; }
</style>
