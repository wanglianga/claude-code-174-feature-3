<template>
  <div>
    <el-alert title="补助闭环：困难类型+证明、权属证明、户主同意、方案告知、高风险停用/转移、预算明细、施工队资质——8项全部通过才进入乡镇复核；批准后也必须在复查合格销号后才能发放；存在补助资格争议未办结的不得批准。"
      type="warning" :closable="false" show-icon style="margin-bottom:12px" />

    <el-alert v-if="archive.emergencyAid" type="success" :closable="false" show-icon style="margin-bottom:12px"
      :title="`困难家庭双通道：另有一笔临时安置救助 ¥${Number(archive.emergencyAid.amount).toLocaleString()}（${SUBSIDY_STATUS[archive.emergencyAid.status].label}）——民政安置任务落实后发放，不等待工程销号；详见“雨后风险事件”页签`" />

    <el-row :gutter="12">
      <el-col :span="14">
        <el-card shadow="never">
          <template #header>资格校验（实时读取各环节状态）</template>
          <el-table :data="guards" size="small" v-loading="loading" border>
            <el-table-column label="校验项" width="180">
              <template #default="{ row }"><b>{{ row.label }}</b></template>
            </el-table-column>
            <el-table-column label="结论" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.ok?'success':'danger'">{{ row.ok ? '通过' : '不通过' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="message" label="说明" />
          </el-table>
          <div v-if="archive.subsidy" style="margin-top:10px">
            申请金额：<b class="money">¥{{ Number(archive.subsidy.amount).toLocaleString() }}</b>
            <el-tag style="margin-left:8px" :type="SUBSIDY_STATUS[archive.subsidy.status].type">{{ SUBSIDY_STATUS[archive.subsidy.status].label }}</el-tag>
            <div v-if="archive.subsidy.reviewComment" class="sub">复核意见：{{ archive.subsidy.reviewComment }}</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="10">
        <el-card shadow="never">
          <template #header>补助操作</template>
          <el-form label-width="100px" v-if="canApply">
            <el-form-item label="申请金额(元)">
              <el-input-number v-model="amount" :min="0" :max="maxAmount || 999999" :step="1000" />
              <div class="sub">上限 = min(核定预算×70%, 50000) = ¥{{ (maxAmount||0).toLocaleString() }}</div>
            </el-form-item>
            <el-button type="primary" @click="submit">提交/重新校验申请</el-button>
            <div class="sub" style="margin-top:6px">校验未全部通过时申请保存为“补充材料中”，不会进入乡镇复核队列。</div>
          </el-form>

          <div v-if="canReview && archive.subsidy?.status==='SUBMITTED'" style="margin-top:10px">
            <el-input v-model="comment" type="textarea" :rows="2" placeholder="复核意见" />
            <el-button type="success" style="margin-top:8px" @click="review(true)">批准</el-button>
            <el-button type="danger" @click="review(false)">驳回</el-button>
          </div>

          <div v-if="auth.isCounty && archive.subsidy?.status==='APPROVED'" style="margin-top:10px">
            <el-alert type="info" :closable="false" title="资金发放闸：未销号前发放按钮将被后端拒绝。" style="margin-bottom:8px" />
            <el-button type="warning" @click="pay">验收销号后发放补助</el-button>
          </div>
          <el-empty v-if="!canApply && !canReview && !(auth.isCounty && archive.subsidy?.status==='APPROVED')" description="暂无补助申请" :image-size="60" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '../api';
import { SUBSIDY_STATUS } from '../labels';
import { useAuthStore } from '../store';

const props = defineProps(['archive']);
const emit = defineEmits(['reload']);
const auth = useAuthStore();
const guards = ref([]);
const loading = ref(false);
const amount = ref(10000);
const comment = ref('');
const canApply = computed(() => ['FARMER', 'TOWNSHIP_REVIEWER', 'COUNTY_ADMIN'].includes(auth.role));
const canReview = computed(() => ['TOWNSHIP_REVIEWER', 'COUNTY_ADMIN'].includes(auth.role));
const budget = computed(() => Number(props.archive.constructionPlan?.budgetTotal || 0));
const maxAmount = computed(() => Math.min(Math.round(budget.value * 0.7), 50000));

async function loadGuards() {
  if (!props.archive.house) return;
  loading.value = true;
  try {
    const { data } = await http.get(`/api/houses/${props.archive.house.id}/subsidy-guards`);
    guards.value = data;
  } finally {
    loading.value = false;
  }
}
onMounted(loadGuards);
watch(() => props.archive.house?.id, loadGuards);

async function submit() {
  const { data } = await http.post(`/api/houses/${props.archive.house.id}/subsidy`, { amount: amount.value });
  ElMessage[data.allPass ? 'success' : 'warning'](data.allPass ? '资格校验全部通过，已进入乡镇复核' : '仍有校验项未通过，申请退回补充材料');
  emit('reload');
  loadGuards();
}
async function review(approved) {
  await http.post(`/api/subsidies/${props.archive.subsidy.id}/review`, { approved, comment: comment.value });
  ElMessage.success(approved ? '已批准，待销号后发放' : '已驳回');
  emit('reload');
}
async function pay() {
  await ElMessageBox.confirm('确认该房屋已验收销号、整改真实完成，发放补助资金？', '资金发放', { type: 'warning' });
  await http.post(`/api/subsidies/${props.archive.subsidy.id}/pay`, {});
  ElMessage.success('补助已发放');
  emit('reload');
}
</script>
<style scoped>.money{color:#f56c6c;font-size:16px}.sub{color:#8a97a6;font-size:12px;margin-top:4px}</style>
