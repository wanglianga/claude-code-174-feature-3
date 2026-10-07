<template>
  <el-card shadow="never">
    <template #header>连续暴雨后险情上报（系统自动筛选是否需要重新上门，并接回原风险档案）</template>
    <el-alert type="warning" :closable="false" show-icon style="margin-bottom:14px"
      title="同一房屋三天内反复上报将合并为一条持续升级的风险事件，不再产生多条互不关联的通知；正在整改的房屋不会因新告警被重置，系统区分继续原计划 / 延长整改 / 先转移。" />
    <el-form label-width="130px" style="max-width:860px">
      <el-form-item label="选择房屋档案">
        <el-select v-model="houseId" filterable placeholder="按档案号/户主搜索" style="width:480px" @change="onHouse">
          <el-option v-for="h in houses" :key="h.id" :value="h.id"
            :label="`${h.code} · ${h.ownerName} · ${h.township}${h.village} · ${RISK[h.riskLevel].label}/${STATUS[h.status]?.label}`" />
        </el-select>
      </el-form-item>

      <div v-if="house" class="snap">
        <el-descriptions :column="3" size="small" border>
          <el-descriptions-item label="历史裂缝">{{ ['无','明显','严重'][house.wallCrack] }}</el-descriptions-item>
          <el-descriptions-item label="历史渗漏">{{ ['无','局部','严重'][house.roofLeak] }}</el-descriptions-item>
          <el-descriptions-item label="历史沉降">{{ ['无','明显','严重'][house.foundationSettlement] }}</el-descriptions-item>
          <el-descriptions-item label="档案风险等级">
            <el-tag size="small" :type="RISK[house.riskLevel].type">{{ RISK[house.riskLevel].label }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="治理状态">
            <el-tag size="small" :type="STATUS[house.status]?.type">{{ STATUS[house.status]?.label }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="登记居住人数">{{ house.residents }}</el-descriptions-item>
        </el-descriptions>
        <el-text v-if="activeEvent" type="danger" size="small">
          ⚠ 该屋已有未闭环风险事件 {{ activeEvent.code }}（已上报 {{ activeEvent.reportCount }} 次，{{ EVENT_STATUS[activeEvent.status]?.label }}），本次上报将并入该事件持续跟踪。
        </el-text>
      </div>

      <el-divider content-position="left">本次暴雨后现场情况（0=无 1=明显 2=严重）</el-divider>
      <el-row :gutter="10">
        <el-col :span="8"><el-form-item label="墙体裂缝"><el-radio-group v-model="f.wallCrack"><el-radio-button :value="0">无</el-radio-button><el-radio-button :value="1">明显</el-radio-button><el-radio-button :value="2">严重</el-radio-button></el-radio-group></el-form-item></el-col>
        <el-col :span="8"><el-form-item label="屋面渗漏"><el-radio-group v-model="f.roofLeak"><el-radio-button :value="0">无</el-radio-button><el-radio-button :value="1">局部</el-radio-button><el-radio-button :value="2">严重</el-radio-button></el-radio-group></el-form-item></el-col>
        <el-col :span="8"><el-form-item label="地基沉降"><el-radio-group v-model="f.foundationSettlement"><el-radio-button :value="0">无</el-radio-button><el-radio-button :value="1">明显</el-radio-button><el-radio-button :value="2">严重</el-radio-button></el-radio-group></el-form-item></el-col>
      </el-row>
      <el-row :gutter="10">
        <el-col :span="8"><el-form-item label="现场仍住人数"><el-input-number v-model="f.residentsAtSite" :min="0" :max="50" controls-position="right" style="width:100%" /></el-form-item></el-col>
        <el-col :span="16"><el-form-item label="上报时间"><el-date-picker v-model="f.reportedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" placeholder="默认为当前时间" style="width:100%" /></el-form-item></el-col>
      </el-row>
      <el-form-item label="现场照片">
        <el-upload :action="uploadUrl" :headers="headers" :on-success="(r)=>f.photos.push(r.url)" :show-file-list="false">
          <el-button>上传照片</el-button>
        </el-upload>
        <el-tag v-for="(u,i) in f.photos" :key="i" closable style="margin:4px 6px 0" @close="f.photos.splice(i,1)">照片{{ i+1 }}</el-tag>
      </el-form-item>
      <el-form-item label="现场说明"><el-input v-model="f.note" type="textarea" :rows="3" placeholder="如：一夜暴雨后后墙新增斜向裂缝、房前地面塌陷" /></el-form-item>
      <el-form-item>
        <el-button type="primary" size="large" @click="submit" :loading="saving">提交暴雨险情上报</el-button>
      </el-form-item>
    </el-form>

    <el-dialog v-model="result.show" title="系统筛选结果" width="640px">
      <el-result v-if="!result.needVisit" icon="info" title="本次上报暂不需要重新上门" sub-title="已留痕并入日常监测，原整改计划保持不变，不打扰处置人员">
        <template #extra>
          <el-text type="info" size="small" tag="div">研判等级：{{ RISK[result.level]?.label }}；隐患较档案无加重</el-text>
          <el-button type="primary" @click="reset">继续上报下一户</el-button>
        </template>
      </el-result>
      <div v-else>
        <el-result icon="warning" :title="result.merged ? `已并入持续风险事件 ${result.eventCode}` : '已建立风险事件，需要重新上门'"
          :sub-title="result.dispatched ? '风险升至转移级，村干部/住建/民政已同步收到同一处置任务' : '住建需分流：继续原计划 / 延长整改 / 先转移'">
        </el-result>
        <el-alert v-for="(r,i) in result.reasons" :key="i" :title="r" type="warning" :closable="false" show-icon style="margin-top:6px" />
        <div style="margin-top:14px;text-align:right">
          <el-button @click="reset">继续上报</el-button>
          <el-button type="primary" @click="goEvent">查看风险事件</el-button>
          <el-button type="success" @click="goHouse">进入房屋档案</el-button>
        </div>
      </div>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import http from '../api';
import { RISK, STATUS, EVENT_STATUS } from '../labels';

const router = useRouter();
const route = useRoute();
const houses = ref([]);
const houseId = ref('');
const house = ref(null);
const activeEvent = ref(null);
const saving = ref(false);
const uploadUrl = '/api/upload';
const headers = computed(() => ({ Authorization: `Bearer ${localStorage.getItem('rhs_token')}` }));
const f = reactive({ wallCrack: 0, roofLeak: 1, foundationSettlement: 0, residentsAtSite: 0, reportedAt: '', photos: [], note: '' });
const result = reactive({ show: false, needVisit: false, merged: false, eventCode: '', eventId: '', houseId: '', reasons: [], level: 'NORMAL', dispatched: false });

async function onHouse(id) {
  const { data } = await http.get(`/api/houses/${id}/archive`);
  house.value = data.house;
  f.residentsAtSite = data.house.residents;
  activeEvent.value = (data.activeRiskEvents || [])[0] || null;
}
async function submit() {
  if (!houseId.value) return ElMessage.warning('请选择房屋档案');
  saving.value = true;
  try {
    const payload = { houseId: houseId.value, ...f };
    if (!payload.reportedAt) delete payload.reportedAt;
    const { data } = await http.post('/api/rain-reports', payload);
    Object.assign(result, {
      show: true,
      needVisit: data.needVisit,
      merged: data.merged,
      eventCode: data.event?.code,
      eventId: data.event?.id,
      houseId: houseId.value,
      reasons: data.screening?.reasons || [],
      level: data.report?.riskLevel,
      dispatched: data.dispatched,
    });
  } finally {
    saving.value = false;
  }
}
function reset() {
  result.show = false;
  houseId.value = ''; house.value = null; activeEvent.value = null;
  Object.assign(f, { wallCrack: 0, roofLeak: 1, foundationSettlement: 0, residentsAtSite: 0, reportedAt: '', photos: [], note: '' });
}
function goEvent() { result.show = false; router.push(`/risk-events/${result.eventId}`); }
function goHouse() { result.show = false; router.push(`/houses/${result.houseId}`); }

onMounted(async () => {
  const { data } = await http.get('/api/houses', { params: { limit: 500 } });
  houses.value = data.data;
  if (route.query.houseId && houses.value.some((h) => h.id === route.query.houseId)) {
    houseId.value = route.query.houseId;
    await onHouse(houseId.value);
  }
});
</script>

<style scoped>
.snap { background:#f7f9fc; border-radius:8px; padding:12px 14px; margin-bottom:14px; }
</style>
