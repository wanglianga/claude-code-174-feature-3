<template>
  <router-view v-if="$route.meta.public" />
  <el-container v-else class="layout">
    <el-aside width="230px" class="aside">
      <div class="brand">
        <el-icon><House /></el-icon>
        <div>
          <div class="title">农房安全治理平台</div>
          <div class="sub">巡查 · 整改 · 补助 · 销号</div>
        </div>
      </div>
      <el-menu :default-active="$route.path" router class="menu" background-color="#173a5e" text-color="#c7d6e5" active-text-color="#ffd04b">
        <el-menu-item index="/dashboard"><el-icon><DataAnalysis /></el-icon><span>县级治理驾驶舱</span></el-menu-item>
        <el-menu-item index="/houses"><el-icon><Files /></el-icon><span>房屋档案台账</span></el-menu-item>
        <el-menu-item v-if="canRain" index="/rain"><el-icon><Umbrella /></el-icon><span>暴雨后复核台</span></el-menu-item>
        <el-menu-item v-if="canInspect" index="/inspect"><el-icon><EditPen /></el-icon><span>巡查登记</span></el-menu-item>
        <el-menu-item v-if="auth.isCounty || auth.isTownship" index="/teams"><el-icon><Tools /></el-icon><span>施工队资质</span></el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <div class="crumb">县域农村自建房安全巡查整改补助平台</div>
        <div class="user">
          <el-tag size="small" type="primary" effect="dark">{{ roleLabel }}</el-tag>
          <span class="uname">{{ auth.user?.name }}</span>
          <el-dropdown @command="onCommand">
            <el-avatar :size="30" class="avatar">{{ auth.user?.name?.[0] }}</el-avatar>
            <template #dropdown><el-dropdown-menu>
              <el-dropdown-item command="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </el-header>
      <el-main class="main"><router-view /></el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './store';
import { ROLE_LABELS } from './labels';

const auth = useAuthStore();
const router = useRouter();
const roleLabel = computed(() => ROLE_LABELS[auth.user?.role] || '');
const canInspect = computed(() => ['GRID_WORKER', 'TOWNSHIP_REVIEWER', 'COUNTY_ADMIN'].includes(auth.role));
const canRain = computed(() => ['GRID_WORKER', 'TOWNSHIP_REVIEWER', 'COUNTY_ADMIN', 'CADRE', 'CIVIL_AFFAIRS', 'ACCEPTOR'].includes(auth.role));
function onCommand(c) {
  if (c === 'logout') {
    auth.logout();
    router.push('/login');
  }
}
</script>

<style>
body { margin: 0; font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #f2f5f9; }
.layout { min-height: 100vh; }
.aside { background: #173a5e; color: #fff; }
.brand { display: flex; gap: 10px; align-items: center; padding: 18px 16px; }
.brand .el-icon { font-size: 30px; color: #ffd04b; }
.brand .title { font-size: 15px; font-weight: 700; line-height: 1.3; }
.brand .sub { font-size: 11px; color: #9db4c9; margin-top: 2px; }
.menu { border-right: none; }
.header { background: #fff; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e6ebf2; }
.crumb { font-weight: 600; color: #263445; }
.user { display: flex; align-items: center; gap: 10px; }
.uname { color: #4b5b6e; font-size: 13px; }
.avatar { background: #2f6fb3; cursor: pointer; }
.main { padding: 18px; }
.card-title { font-weight: 700; margin-bottom: 12px; color: #1f2d3d; }
.section-hint { color: #8a97a6; font-size: 12px; margin-top: 6px; }
</style>
