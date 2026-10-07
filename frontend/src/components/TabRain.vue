<template>
  <div v-loading="loading">
    <el-alert
      title="同栋房屋三天（72小时）内反复上报合并为一条持续升级风险事件；整改中的房屋不被新告警重置状态，乡镇按风险区分继续原计划、延长整改、先转移；转移级时村干部/住建/民政收到同一处置任务；复查合格后才恢复正常等级并允许销号。"
      type="info" :closable="false" show-icon style="margin-bottom:12px" />

    <el-empty v-if="!events.length" description="该房屋暂无暴雨后风险事件" :image-size="70" />

    <el-collapse v-else v-model="active">
      <el-collapse-item v-for="e in events" :key="e.id" :name="e.id">
        <template #title>
          <span class="ev-title">
            <el-tag size="small" :type="RAIN_EVENT_STATUS[e.status].type">{{ RAIN_EVENT_STATUS[e.status].label }}</el-tag>
            <el-tag size="small" :type="RISK[e.riskLevel].type" effect="dark">{{ RISK[e.riskLevel].label }}</el-tag>
            <el-tag size="small" type="danger" effect="plain">第{{ e.stage }}档 · {{ e.reportCount }}次上报</el-tag>
            <el-tag v-if="e.disposition" size="small" :type="RAIN_DISPOSITION[e.disposition].type">{{ RAIN_DISPOSITION[e.disposition].label }}</el-tag>
            <el-tag v-if="e.difficultFamily" size="small" type="warning">困难家庭</el-tag>
            <span class="sub">首次 {{ fmtDate(e.createdAt) }} · 最近 {{ fmtDate(e.lastReportAt) }}</span>
          </span>
        </template>

        <!-- 历次上报（一条事件的时间线） -->
        <el-card shadow="hover" class="inner">
          <template #header>事件上报记录（聚合为一条，不产生重复通知）</template>
          <el-timeline>
            <el-timeline-item v-for="r in reportsOf(e.id)" :key="r.id" :timestamp="fmtDate(r.reportedAt)" placement="top"
              :type="r.stage >= 3 ? 'danger' : r.stage === 2 ? 'warning' : 'primary'">
              <div class="rpt">
                第{{ r.stage }}次上报 · 裂缝{{ ['无','明显','严重'][r.wallCrack] }} / 渗漏{{ ['无','局部','严重'][r.roofLeak] }} / 沉降{{ ['无','明显','严重'][r.foundationSettlement] }} · {{ r.residents }}人
                <el-tag size="small" :type="RISK[r.riskLevel].type">{{ RISK[r.riskLevel].label }}</el-tag>
              </div>
              <div v-if="r.notes" class="sub">{{ r.notes }}</div>
              <div class="sub">{{ (r.reasons || []).join('；') }}</div>
              <div class="sub">上报人：{{ r.reporterName }}</div>
            </el-timeline-item>
          </el-timeline>
        </el-card>

        <!-- 乡镇处置决定 -->
        <el-card shadow="hover" class="inner">
          <template #header>乡镇处置决定（不重置原整改流程）</template>
          <div v-if="e.decidedAt">
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="处置决定">
                <el-tag size="small" :type="RAIN_DISPOSITION[e.disposition].type">{{ RAIN_DISPOSITION[e.disposition].label }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="决定人">{{ e.decidedByName }} · {{ fmtDate(e.decidedAt) }}</el-descriptions-item>
              <el-descriptions-item v-if="e.extendedDeadline" label="延长后期限">{{ e.extendedDeadline }}</el-descriptions-item>
              <el-descriptions-item label="说明">{{ e.dispositionNote || '—' }}</el-descriptions-item>
              <el-descriptions-item label="事件前等级">
                <el-tag size="small" :type="RISK[e.previousRiskLevel]?.type">{{ RISK[e.previousRiskLevel]?.label || '—' }}</el-tag>
                （复查合格后恢复）
              </el-descriptions-item>
            </el-descriptions>
          </div>
          <div v-if="canDecide && e.status !== 'RESTORED'">
            <el-radio-group v-model="decisions[e.id].decision" style="margin-bottom:10px">
              <el-radio-button label="CONTINUE">继续原计划</el-radio-button>
              <el-radio-button label="EXTEND">延长整改</el-radio-button>
              <el-radio-button label="EVACUATE">先安排人员转移</el-radio-button>
            </el-radio-group>
            <div v-if="decisions[e.id].decision === 'EXTEND'" class="row">
              <el-date-picker v-model="decisions[e.id].newDeadline" type="date" value-format="YYYY-MM-DD" placeholder="新整改期限（须晚于原期限）" />
            </div>
            <el-input v-model="decisions[e.id].note" type="textarea" :rows="2" placeholder="处置说明（延长原因/转移范围/监测要求）" style="margin:8px 0" />
            <el-button type="primary" @click="submitDecision(e.id)">下达处置决定</el-button>
            <span class="sub" style="margin-left:8px">选择“先转移”将同步向村干部、住建、民政下达同一处置任务</span>
          </div>
          <el-text v-else-if="!canDecide && !e.decidedAt" type="info" size="small">待乡镇住建人员作出处置决定</el-text>
        </el-card>

        <!-- 同一处置任务（三方） -->
        <el-card v-if="tasksOf(e.id).length" shadow="hover" class="inner">
          <template #header>同一处置任务 · 村干部 / 住建 / 民政</template>
          <el-table :data="tasksOf(e.id)" size="small" border>
            <el-table-column label="责任方" width="90">
              <template #default="{ row }"><el-tag size="small" :type="RAIN_TASK_TYPE[row.taskType].type">{{ RAIN_TASK_TYPE[row.taskType].label }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="title" label="任务" min-width="180" />
            <el-table-column label="落实人/状态" width="170">
              <template #default="{ row }">
                <el-tag size="small" :type="RAIN_TASK_STATUS[row.status].type">{{ RAIN_TASK_STATUS[row.status].label }}</el-tag>
                <div class="sub">{{ row.assignees?.map(a => a.userName || '待领取').join('、') }}</div>
              </template>
            </el-table-column>
            <el-table-column label="处置结果" min-width="220">
              <template #default="{ row }">
                <span v-if="row.result">{{ row.result }}</span>
                <el-button v-else-if="canDoTask" link type="primary" @click="finishTask(row)">填写结果办结</el-button>
                <span v-else class="sub">待落实</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <!-- 困难家庭双通道救助 -->
        <el-card v-if="e.difficultFamily" shadow="hover" class="inner">
          <template #header>困难家庭救助（临时安置与修缮补助可并行）</template>
          <div class="aid-row">
            <div>
              <el-tag size="small" type="primary">修缮补助</el-tag>
              <span class="sub">复查合格销号后发放</span>
            </div>
            <div>
              <el-tag size="small" type="warning">临时安置救助</el-tag>
              <span class="sub">民政安置任务落实后即可发放，上限¥10,000</span>
              <el-button v-if="canCivil" size="small" type="warning" @click="applyEmergency(e.id)">
                {{ emergencyAid && emergencyAid.status !== 'DRAFT' ? '查看/重提应急救助' : '受理临时安置救助' }}
              </el-button>
            </div>
          </div>
          <div v-if="emergencyAid" class="aid-box">
            <el-table :data="emergencyAid.guardResults" size="small" border>
              <el-table-column prop="label" label="资格项" width="150" />
              <el-table-column label="结论" width="80">
                <template #default="{ row }"><el-tag size="small" :type="row.ok?'success':'danger'">{{ row.ok?'通过':'不通过' }}</el-tag></template>
              </el-table-column>
              <el-table-column prop="message" label="说明" />
            </el-table>
            <div class="row" style="margin-top:8px">
              金额：<b class="money">¥{{ Number(emergencyAid.amount).toLocaleString() }}</b>
              <el-tag size="small" style="margin-left:8px" :type="SUBSIDY_STATUS[emergencyAid.status].type">{{ SUBSIDY_STATUS[emergencyAid.status].label }}</el-tag>
              <el-button v-if="canCivil && emergencyAid.status === 'APPROVED'" size="small" type="warning" @click="payEmergency">安置落实后发放</el-button>
            </div>
          </div>
        </el-card>

        <!-- 雨后复查 -->
        <el-card shadow="hover" class="inner">
          <template #header>雨后复查（合格恢复正常等级并可销号；不合格继续阻断）</template>
          <el-alert v-if="e.status === 'RESTORED'" type="success" :closable="false" show-icon
            :title="`复查合格，已恢复风险等级并关闭事件（${fmtDate(e.restoredAt)}）：${e.restoreNote || ''}`" />
          <template v-else>
            <div v-if="e.status === 'OPEN'" class="sub">须先由乡镇作出处置决定，才能复查。</div>
            <template v-else>
              <el-radio-group v-model="rechecks[e.id].result" style="margin-bottom:8px">
                <el-radio-button label="PASS">复查合格</el-radio-button>
                <el-radio-button label="FAIL">复查不合格</el-radio-button>
              </el-radio-group>
              <div class="row">
                <span class="sub">现场实测：</span>
                裂缝
                <el-select v-model="rechecks[e.id].wallCrack" style="width:90px"><el-option :value="0" label="无" /><el-option :value="1" label="明显" /><el-option :value="2" label="严重" /></el-select>
                渗漏
                <el-select v-model="rechecks[e.id].roofLeak" style="width:90px"><el-option :value="0" label="无" /><el-option :value="1" label="局部" /><el-option :value="2" label="严重" /></el-select>
                沉降
                <el-select v-model="rechecks[e.id].foundationSettlement" style="width:90px"><el-option :value="0" label="无" /><el-option :value="1" label="明显" /><el-option :value="2" label="严重" /></el-select>
              </div>
              <el-input v-model="rechecks[e.id].notes" type="textarea" :rows="2" placeholder="复查说明" style="margin:8px 0" />
              <el-button v-if="canRecheck" type="primary" @click="submitRecheck(e.id)">提交雨后复查</el-button>
              <span v-else class="sub">由网格员/验收人员提交复查</span>
            </template>
          </template>
        </el-card>
      </el-collapse-item>
    </el-collapse>

    <!-- 任务办结 -->
    <el-dialog v-model="taskVisible" title="处置任务办结" width="540px">
      <el-input v-model="taskResult" type="textarea" :rows="4" placeholder="必须填写实际处置结果" />
      <template #footer>
        <el-button @click="taskVisible = false">取消</el-button>
        <el-button type="primary" @click="submitTaskResult">确认办结</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '../api';
import { RISK, RAIN_EVENT_STATUS, RAIN_DISPOSITION, RAIN_TASK_TYPE, RAIN_TASK_STATUS, SUBSIDY_STATUS, fmtDate } from '../labels';
import { useAuthStore } from '../store';

const props = defineProps(['archive']);
const emit = defineEmits(['reload']);
const auth = useAuthStore();
const loading = ref(false);
const active = ref('');

const events = computed(() => props.archive.rainEvents || []);
const reports = computed(() => props.archive.rainReports || []);
const tasks = computed(() => props.archive.rainTasks || []);
const emergencyAid = computed(() => props.archive.emergencyAid || null);

const canDecide = computed(() => ['TOWNSHIP_REVIEWER', 'COUNTY_ADMIN'].includes(auth.role));
const canRecheck = computed(() => ['GRID_WORKER', 'ACCEPTOR', 'COUNTY_ADMIN', 'TOWNSHIP_REVIEWER'].includes(auth.role));
const canDoTask = computed(() => ['TOWNSHIP_REVIEWER', 'COUNTY_ADMIN', 'CADRE', 'CIVIL_AFFAIRS'].includes(auth.role));
const canCivil = computed(() => ['CIVIL_AFFAIRS', 'COUNTY_ADMIN'].includes(auth.role));

const reportsOf = (eid) => reports.value.filter((r) => r.eventId === eid);
const tasksOf = (eid) => tasks.value.filter((t) => t.eventId === eid);

function blankDecision() { return { decision: 'CONTINUE', newDeadline: '', note: '' }; }
const decisions = reactive({});
function blankRecheck() { return { result: 'PASS', wallCrack: 0, roofLeak: 0, foundationSettlement: 0, notes: '' }; }
const rechecks = reactive({});
watch(events, (list) => {
  for (const e of list) {
    if (!decisions[e.id]) decisions[e.id] = blankDecision();
    if (!rechecks[e.id]) rechecks[e.id] = blankRecheck();
    if (!active.value && e.status !== 'RESTORED') active.value = e.id;
  }
}, { immediate: true });

async function submitDecision(eid) {
  const d = decisions[eid];
  if (d.decision === 'EXTEND' && !d.newDeadline) return ElMessage.warning('延长整改必须选择新期限');
  await http.post('/api/rain/events/decide', { eventId: eid, ...d });
  ElMessage.success('处置决定已下达');
  emit('reload');
}
async function submitRecheck(eid) {
  const r = rechecks[eid];
  const { data } = await http.post('/api/rain/rechecks', { eventId: eid, ...r });
  ElMessage[data.restored ? 'success' : 'warning'](data.restored ? '复查合格，已恢复正常等级' : '复查不合格，事件继续处置，验收/销号冻结');
  emit('reload');
}

const taskVisible = ref(false);
const taskResult = ref('');
const currentTask = ref(null);
function finishTask(row) { currentTask.value = row; taskResult.value = ''; taskVisible.value = true; }
async function submitTaskResult() {
  if (!taskResult.value.trim()) return ElMessage.warning('必须填写处置结果');
  await http.post('/api/rain/tasks/complete', { taskId: currentTask.value.id, result: taskResult.value });
  ElMessage.success('任务已办结');
  taskVisible.value = false;
  emit('reload');
}

async function applyEmergency(eid) {
  const amountStr = await ElMessageBox.prompt('临时安置救助申请金额（上限 ¥10,000）', '民政应急通道', {
    inputValue: '5000', inputPattern: /^\d+$/, inputErrorMessage: '请输入数字金额',
  }).then((r) => r.value).catch(() => null);
  if (amountStr == null) return;
  const { data } = await http.post(`/api/houses/${props.archive.house.id}/subsidy`, { aidKind: 'EMERGENCY', amount: Number(amountStr) });
  ElMessage[data.allPass ? 'success' : 'warning'](data.allPass ? '资格通过，已进入民政复核' : '资格校验未全部通过');
  if (data.allPass) {
    await http.post(`/api/subsidies/${data.application.id}/review`, { approved: true, comment: '民政应急通道复核通过' });
    ElMessage.success('民政已批准，待安置任务落实后发放');
  }
  emit('reload');
}
async function payEmergency() {
  await ElMessageBox.confirm('确认人员临时安置已落实，发放临时安置救助金？', '应急救助发放', { type: 'warning' });
  await http.post(`/api/subsidies/${emergencyAid.value.id}/pay`, {});
  ElMessage.success('临时安置救助金已发放');
  emit('reload');
}
</script>

<style scoped>
.ev-title { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.inner { margin: 8px 0 14px; }
.sub { color:#8a97a6; font-size:12px; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:4px 0; }
.rpt { display:flex; gap:8px; align-items:center; font-weight:600; font-size:13.5px; flex-wrap:wrap; }
.money { color:#f56c6c; }
.aid-row > div { margin:6px 0; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.aid-box { margin-top:8px; }
</style>
