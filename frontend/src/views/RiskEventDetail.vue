<template>
  <div v-loading="loading">
    <el-page-header @back="$router.back()" content="风险事件处置" class="ph" />

    <el-card v-if="d.event" shadow="never" class="head-card">
      <div class="egrid">
        <div>
          <div class="e1">
            {{ d.event.code }}
            <el-tag :type="RISK[d.event.riskLevel].type" effect="dark" size="large">{{ RISK[d.event.riskLevel].label }}</el-tag>
            <el-tag :type="EVENT_STATUS[d.event.status]?.type" size="large">{{ EVENT_STATUS[d.event.status]?.label }}</el-tag>
            <el-tag v-if="d.event.triageDecision" size="large" type="warning" effect="plain">分流：{{ TRIAGE[d.event.triageDecision]?.label }}</el-tag>
          </div>
          <div class="e2">
            <el-link type="primary" @click="$router.push(`/houses/${d.house.id}`)">{{ d.house.code }} · {{ d.house.ownerName }}</el-link>
            {{ d.house.township }} · {{ d.house.village }} · {{ d.house.address }}
          </div>
          <div class="e3">
            事件前：{{ RISK[d.event.previousRiskLevel].label }} / {{ STATUS[d.event.previousHouseStatus]?.label }}
            · 原整改期限：{{ d.event.deadlineSnapshot || '—' }}
            · 累计上报 <b>{{ d.event.reportCount }}</b> 次（最近 {{ fmtDate(d.event.lastReportAt) }}）
          </div>
          <div class="e3" v-if="d.family && d.family.difficultyType !== 'NONE'">
            <el-tag type="danger" effect="plain">困难家庭：{{ DIFFICULTY[d.family.difficultyType] }}</el-tag>
            <span class="mem">{{ d.family.membersNote }}</span>
          </div>
        </div>
        <div class="snapshot">
          <div class="rt">上次复查/整改结论快照</div>
          <el-text size="small" tag="div">{{ d.event.lastReviewSnapshot || '—' }}</el-text>
          <el-text size="small" tag="div" v-if="d.event.triageNote" style="margin-top:6px">分流说明：{{ d.event.triageNote }}（{{ d.event.triagedByName }}）</el-text>
        </div>
      </div>
      <el-alert v-if="d.allDone && d.event.status !== 'CLOSED'" type="success" show-icon :closable="false" style="margin-top:10px"
        title="三方处置任务已全部办结：待住建组织复查，复查合格后由县级销号，事件自动闭环、风险等级恢复正常。" />
    </el-card>

    <el-row :gutter="12" style="margin-top:12px">
      <el-col :span="14">
        <!-- 持续升级过程 -->
        <el-card shadow="never">
          <template #header>持续升级过程（三天内反复上报合并为同一条事件）</template>
          <el-timeline>
            <el-timeline-item v-for="(l,i) in (d.event.escalationLog||[]).slice().reverse()" :key="i" :timestamp="fmtDate(l.at)" placement="top"
              :type="l.riskLevel==='EVACUATE'?'danger':l.riskLevel==='SUSPEND'?'warning':'primary'">
              <el-tag size="small" :type="RISK[l.riskLevel]?.type">{{ RISK[l.riskLevel]?.label }}</el-tag>
              <span style="margin-left:6px">{{ l.action }}</span>
              <div v-if="l.note" class="sub">{{ l.note }}</div>
            </el-timeline-item>
          </el-timeline>
        </el-card>

        <!-- 历次上报 -->
        <el-card shadow="never" style="margin-top:12px">
          <template #header>并入本事件的暴雨险情上报（{{ d.reports.length }}）</template>
          <el-table :data="d.reports" size="small" border>
            <el-table-column label="时间" width="150"><template #default="{row}">{{ fmtDate(row.reportedAt) }}</template></el-table-column>
            <el-table-column label="裂/渗/沉" width="100">
              <template #default="{row}">{{ row.wallCrack }}/{{ row.roofLeak }}/{{ row.foundationSettlement }}</template>
            </el-table-column>
            <el-table-column label="研判" width="90">
              <template #default="{row}"><el-tag size="small" :type="RISK[row.riskLevel].type">{{ RISK[row.riskLevel].label }}</el-tag></template>
            </el-table-column>
            <el-table-column label="并入" width="70">
              <template #default="{row}"><el-tag size="small" :type="row.merged?'warning':'success'">{{ row.merged?'并入':'首次' }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="note" label="现场说明" min-width="180" />
            <el-table-column prop="reporterName" label="上报人" width="110" />
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="10">
        <!-- 住建分流 -->
        <el-card v-if="d.event.status === 'ACTIVE' && canTriage" shadow="never">
          <template #header>住建分流（不重置原整改状态）</template>
          <el-radio-group v-model="triage.decision" style="display:flex;flex-direction:column;gap:10px">
            <el-radio value="CONTINUE" :disabled="d.event.riskLevel==='EVACUATE'">继续原整改计划 —— 险情可控，期限/措施不变，村级加密监测</el-radio>
            <el-radio value="EXTEND">延长整改期限 —— 在原方案上加项加固，已完成工序保留</el-radio>
            <el-radio value="EVACUATE">先安排人员转移 —— 升级确认后向村干部/住建/民政同步派单</el-radio>
          </el-radio-group>
          <el-date-picker v-if="triage.decision==='EXTEND'" v-model="triage.newDeadline" type="date" value-format="YYYY-MM-DD"
            placeholder="新整改期限（须晚于原期限）" style="width:100%;margin-top:10px" />
          <el-input v-model="triage.note" type="textarea" :rows="2" placeholder="分流说明（进入档案）" style="margin-top:10px" />
          <el-button type="primary" style="margin-top:10px" @click="doTriage">提交分流结论</el-button>
        </el-card>

        <!-- 延期记录 -->
        <el-card v-if="d.extensions?.length" shadow="never" style="margin-top:12px">
          <template #header>整改期限变更（状态不重置）</template>
          <el-timeline>
            <el-timeline-item v-for="x in d.extensions" :key="x.id" :timestamp="fmtDate(x.createdAt)" placement="top" type="warning">
              <b>{{ x.oldDeadline }} → {{ x.newDeadline }}</b>
              <div class="sub">{{ x.reason }}（{{ x.byName }}）</div>
            </el-timeline-item>
          </el-timeline>
        </el-card>

        <!-- 三方处置任务 -->
        <el-card shadow="never" :class="{'mt12': d.event.status !== 'ACTIVE' || !canTriage}">
          <template #header>
            同一处置任务 · 三方协同
            <el-tag size="small" :type="d.pendingCount ? 'danger' : 'success'" style="margin-left:8px">待办 {{ d.pendingCount }}</el-tag>
          </template>
          <el-collapse v-model="activeDept">
            <el-collapse-item v-for="dept in ['CADRE','HOUSING','CIVIL']" :key="dept" :name="dept" :title="`${DISPATCH_DEPT[dept].label}（${tasksOf(dept).filter(t=>t.status==='PENDING').length}待办）`">
              <div v-for="t in tasksOf(dept)" :key="t.id" class="task">
                <div class="t-head">
                  <el-tag size="small" :type="DISPATCH_DEPT[t.dept].type">{{ DISPATCH_DEPT[t.dept].label }}</el-tag>
                  <b>{{ t.title }}</b>
                  <el-tag size="small" :type="DISPATCH_STATUS[t.status].type" style="margin-left:auto">{{ DISPATCH_STATUS[t.status].label }}</el-tag>
                </div>
                <div class="sub">{{ t.content }}</div>
                <div v-if="t.status==='DONE'" class="done">
                  办结人：{{ t.doneByName }}；结果：{{ t.result }}
                  <span v-if="t.amount">；金额 ¥{{ Number(t.amount).toLocaleString() }}</span>
                </div>
                <el-button v-else-if="canComplete(t)" link type="primary" @click="openComplete(t)">办结本任务</el-button>
              </div>
            </el-collapse-item>
          </el-collapse>
        </el-card>

        <el-card v-if="d.event.status==='CLOSED'" shadow="never" style="margin-top:12px">
          <template #header>事件已闭环</template>
          <el-tag type="success">复查合格并销号，风险等级恢复正常</el-tag>
          <div class="sub" style="margin-top:6px">{{ fmtDate(d.event.closedAt) }} · {{ d.event.closedByName }} · {{ d.event.closeNote }}</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 办结任务弹窗 -->
    <el-dialog v-model="dlg.show" :title="`办结任务：${dlg.task?.title}`" width="560px">
      <el-form label-width="110px">
        <el-form-item label="处置结果" required><el-input v-model="dlg.result" type="textarea" :rows="3" placeholder="必须填写实际处置结果" /></el-form-item>
        <template v-if="dlg.task?.kind==='TEMP_SETTLEMENT'">
          <el-form-item label="安置人数"><el-input-number v-model="dlg.residents" :min="0" /></el-form-item>
          <el-form-item label="安置去向">
            <el-select v-model="dlg.destination" allow-create filterable style="width:100%">
              <el-option label="村级安置点" value="村级安置点" /><el-option label="乡镇集中安置点" value="乡镇集中安置点" /><el-option label="投亲靠友" value="投亲靠友" />
            </el-select>
          </el-form-item>
        </template>
        <el-form-item v-if="dlg.task?.dept==='CIVIL'" label="救助/补助金额"><el-input-number v-model="dlg.amount" :min="0" :step="1000" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.show=false">取消</el-button>
        <el-button type="primary" @click="submitComplete">确认办结</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import http from '../api';
import { RISK, STATUS, EVENT_STATUS, TRIAGE, DISPATCH_DEPT, DISPATCH_STATUS, DIFFICULTY, fmtDate } from '../labels';
import { useAuthStore } from '../store';

const route = useRoute();
const auth = useAuthStore();
const d = ref({});
const loading = ref(false);
const triage = reactive({ decision: 'EXTEND', newDeadline: '', note: '' });
const activeDept = ref(['CADRE', 'HOUSING', 'CIVIL']);
const dlg = reactive({ show: false, task: null, result: '', residents: 0, destination: '村级安置点', amount: 0 });

const canTriage = computed(() => ['TOWNSHIP_REVIEWER', 'COUNTY_ADMIN'].includes(auth.role));
const tasksOf = (dept) => (d.value.dispatches || []).filter((t) => t.dept === dept);
function canComplete(t) {
  if (t.status !== 'PENDING') return false;
  if (t.dept === 'CADRE') return ['CADRE', 'COUNTY_ADMIN'].includes(auth.role);
  if (t.dept === 'HOUSING') return ['TOWNSHIP_REVIEWER', 'COUNTY_ADMIN', 'ACCEPTOR'].includes(auth.role);
  return ['CIVIL_ADMIN', 'COUNTY_ADMIN'].includes(auth.role);
}

async function load() {
  loading.value = true;
  try {
    const { data } = await http.get(`/api/risk-events/${route.params.id}`);
    d.value = data;
  } finally {
    loading.value = false;
  }
}
async function doTriage() {
  if (triage.decision === 'EXTEND' && !triage.newDeadline) return ElMessage.warning('请选择新的整改期限');
  await http.post(`/api/risk-events/${route.params.id}/triage`, triage);
  ElMessage.success('分流结论已提交');
  await load();
}
function openComplete(t) {
  Object.assign(dlg, { show: true, task: t, result: '', residents: d.value.house?.residents || 0, destination: '村级安置点', amount: 0 });
}
async function submitComplete() {
  if (!dlg.result) return ElMessage.warning('必须填写处置结果');
  const payload = { result: dlg.result };
  if (dlg.task.kind === 'TEMP_SETTLEMENT') Object.assign(payload, { residents: dlg.residents, destination: dlg.destination, amount: dlg.amount });
  else if (dlg.task.dept === 'CIVIL') payload.amount = dlg.amount;
  await http.post(`/api/dispatch-tasks/${dlg.task.id}/complete`, payload);
  ElMessage.success('任务已办结');
  dlg.show = false;
  await load();
}
onMounted(load);
watch(() => route.params.id, load);
</script>

<style scoped>
.ph { margin-bottom:10px; }
.head-card { border-top:3px solid #f56c6c; }
.egrid { display:flex; justify-content:space-between; gap:24px; }
.e1 { font-size:19px; font-weight:700; display:flex; gap:8px; align-items:center; }
.e2 { color:#445; margin:6px 0; }
.e3 { color:#7a8899; font-size:13px; margin-top:4px; }
.mem { margin-left:8px; color:#7a8899; font-size:12.5px; }
.snapshot { min-width:280px; max-width:400px; background:#f7f9fc; border-radius:8px; padding:10px 14px; }
.rt { font-weight:600; margin-bottom:6px; color:#445; font-size:13px; }
.sub { color:#6b7888; font-size:12.5px; margin-top:3px; }
.task { padding:8px 0; border-bottom:1px dashed #e3e8ef; }
.t-head { display:flex; gap:8px; align-items:center; font-size:13.5px; }
.done { color:#67a23a; font-size:12.5px; margin-top:4px; }
.mt12 { margin-top:12px; }
</style>
