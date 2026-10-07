<template>
  <el-card shadow="never">
    <template #header>
      我的处置任务
      <span class="hint">村干部负责组织转移盯守，住建负责房屋处置/复查销号，民政负责临时安置与困难家庭修缮补助；同一事件三方各执一任务。</span>
    </template>
    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column label="事件" width="120">
        <template #default="{ row }">
          <el-link type="primary" @click="$router.push(`/risk-events/${row.eventId}`)">{{ row.eventCode }}</el-link>
        </template>
      </el-table-column>
      <el-table-column label="责任方" width="90">
        <template #default="{ row }"><el-tag size="small" :type="DISPATCH_DEPT[row.dept].type">{{ DISPATCH_DEPT[row.dept].label }}</el-tag></template>
      </el-table-column>
      <el-table-column label="任务" min-width="200">
        <template #default="{ row }">
          <b>{{ row.title }}</b>
          <div class="sub">{{ row.content }}</div>
        </template>
      </el-table-column>
      <el-table-column label="房屋" min-width="200">
        <template #default="{ row }">{{ row.house?.code }} · {{ row.house?.ownerName }} · {{ row.house?.township }}{{ row.house?.village }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }"><el-tag size="small" :type="DISPATCH_STATUS[row.status].type">{{ DISPATCH_STATUS[row.status].label }}</el-tag></template>
      </el-table-column>
      <el-table-column label="金额" width="110">
        <template #default="{ row }"><span v-if="row.amount">¥{{ Number(row.amount).toLocaleString() }}</span><span v-else>—</span></template>
      </el-table-column>
      <el-table-column label="办结情况" min-width="200">
        <template #default="{ row }">
          <span v-if="row.status==='DONE'">{{ row.doneByName }}：{{ row.result }}</span>
          <el-button v-else link type="primary" @click="$router.push(`/risk-events/${row.eventId}`)">去办结</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import http from '../api';
import { DISPATCH_DEPT, DISPATCH_STATUS } from '../labels';

const rows = ref([]);
const loading = ref(false);
onMounted(async () => {
  loading.value = true;
  try {
    const { data } = await http.get('/api/dispatch-tasks/mine');
    rows.value = data.data;
  } finally {
    loading.value = false;
  }
});
</script>
<style scoped>.hint{color:#8a97a6;font-size:12px;margin-left:10px;font-weight:400}.sub{color:#7a8899;font-size:12px;margin-top:2px}</style>
