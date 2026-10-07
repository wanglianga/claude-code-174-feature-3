import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Roles } from './auth.guard';
import { CurrentUser } from './app.service';
import { UserRole } from './entities';
import { RainService } from './rain.service';

const FIELD_STAFF = [
  UserRole.GRID_WORKER,
  UserRole.TOWNSHIP_REVIEWER,
  UserRole.COUNTY_ADMIN,
  UserRole.CADRE,
  UserRole.CIVIL_ADMIN,
  UserRole.ACCEPTOR,
];

@Controller('api')
export class RainController {
  constructor(private readonly rain: RainService) {}

  // ---------- 暴雨后险情上报（网格员/住建/县）----------
  @Post('rain-reports')
  @Roles(UserRole.GRID_WORKER, UserRole.TOWNSHIP_REVIEWER, UserRole.COUNTY_ADMIN)
  submitReport(@Body() body: any, @Req() req: any) {
    return this.rain.submitReport(req.user as CurrentUser, body);
  }

  // ---------- 风险事件中心 ----------
  @Get('risk-events')
  @Roles(...FIELD_STAFF)
  listEvents(@Query() q: any, @Req() req: any) {
    return this.rain.listEvents(q, req.user as CurrentUser);
  }

  @Get('risk-events/:id')
  @Roles(...FIELD_STAFF)
  eventDetail(@Param('id') id: string) {
    return this.rain.eventDetail(id);
  }

  // ---------- 分流：继续原计划 / 延长整改 / 先转移 ----------
  @Post('risk-events/:id/triage')
  @Roles(UserRole.TOWNSHIP_REVIEWER, UserRole.COUNTY_ADMIN)
  triage(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.rain.triage(req.user as CurrentUser, id, body);
  }

  // ---------- 处置任务 ----------
  @Get('dispatch-tasks/mine')
  @Roles(...FIELD_STAFF)
  myTasks(@Req() req: any) {
    return this.rain.myTasks(req.user as CurrentUser);
  }

  @Post('dispatch-tasks/:id/complete')
  @Roles(UserRole.CADRE, UserRole.TOWNSHIP_REVIEWER, UserRole.COUNTY_ADMIN, UserRole.CIVIL_ADMIN, UserRole.ACCEPTOR)
  completeTask(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.rain.completeTask(req.user as CurrentUser, id, body || {});
  }
}
