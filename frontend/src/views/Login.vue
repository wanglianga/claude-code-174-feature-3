<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="logo"><el-icon :size="34"><House /></el-icon></div>
      <h2>农村自建房安全巡查整改补助平台</h2>
      <p class="sub">巡查 · 复核 · 告知 · 整改 · 安置 · 补助 · 验收 · 销号</p>
      <el-form :model="form" @submit.prevent>
        <el-form-item>
          <el-input v-model="form.username" size="large" placeholder="账号" :prefix-icon="User" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" size="large" type="password" placeholder="密码（演示均为 123456）" :prefix-icon="Lock" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" size="large" style="width:100%" :loading="loading" @click="submit">登 录</el-button>
      </el-form>
      <el-divider>演示账号（点击填充）</el-divider>
      <div class="accounts">
        <el-tag v-for="a in accounts" :key="a.u" class="acc" :type="a.type" effect="plain" @click="form.username = a.u">
          {{ a.label }}：{{ a.u }}
        </el-tag>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { User, Lock } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../store';

const auth = useAuthStore();
const router = useRouter();
const form = reactive({ username: 'county1', password: '123456' });
const loading = ref(false);
const accounts = [
  { u: 'county1', label: '县级', type: 'danger' },
  { u: 'town1', label: '乡镇', type: 'warning' },
  { u: 'grid1', label: '网格员', type: 'success' },
  { u: 'acceptor1', label: '验收员', type: 'primary' },
  { u: 'cadre1', label: '村干部', type: 'warning' },
  { u: 'civil1', label: '民政', type: 'success' },
  { u: 'farmer1', label: '农户', type: 'info' },
  { u: 'team1', label: '施工队', type: '' },
];
async function submit() {
  loading.value = true;
  try {
    await auth.login(form.username, form.password);
    ElMessage.success('登录成功');
    router.push('/dashboard');
  } catch {
    /* 拦截器已提示 */
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #173a5e 0%, #2f6fb3 100%); }
.login-card { width: 430px; background: #fff; border-radius: 14px; padding: 34px 38px; box-shadow: 0 20px 60px rgba(0,0,0,.25); }
.logo { width: 62px; height: 62px; border-radius: 14px; background: #eef5ff; color: #2f6fb3; display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; }
h2 { font-size: 19px; text-align: center; margin: 0 0 6px; color: #1f2d3d; }
.sub { text-align: center; color: #8a97a6; font-size: 12px; margin: 0 0 22px; }
.accounts { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.acc { cursor: pointer; }
</style>
