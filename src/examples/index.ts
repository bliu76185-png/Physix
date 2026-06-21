import freeFall from "../../examples/free-fall.json";
import springOscillator from "../../examples/spring-oscillator.json";
import twoBallPerfectElasticCollision from "../../examples/two-ball-perfect-elastic-collision.json";
import inclinedPlaneSpringProfile from "../../examples/inclined-plane-spring-profile.json";
import hingePendulum from "../../examples/hinge-pendulum.json";
import ropePendulum from "../../examples/rope-pendulum.json";
import pulleySystem from "../../examples/pulley-system.json";
import chargedPendulumFields from "../../examples/charged-pendulum-fields.json";
import springCollisionVertical from "../../examples/spring-collision-vertical.json";
import sliderDamped from "../../examples/slider-damped.json";
import cartStickyCollisionInertiaFriction from "../../examples/cart-sticky-collision-inertia-friction.json";
import varyingField from "../../examples/varying-field.json";
import emGravityChargedBall from "../../examples/em-gravity-charged-ball.json";
import singlePointChargeField from "../../examples/single-point-charge-field.json";
import twoMovingChargesCoulomb from "../../examples/two-moving-charges-coulomb.json";
import twoFixedChargesDipoleField from "../../examples/two-fixed-charges-dipole-field.json";
import spatialVariationField from "../../examples/spatial-variation-field.json";
import siEventTimedRebound from "../../examples/si-event-timed-rebound.json";
import expressionDrivenOscillator from "../../examples/expression-driven-oscillator.json";
import varyingFieldWithEventImpulse from "../../examples/varying-field-with-event-impulse.json";
import { repairStableConstraintSpec } from "../graph/stableConstraintSpec";
import type { PhysicsGraph } from "../graph/types";

export interface ExampleDefinition {
  id: string;
  title: string;
  prompt: string;
  graph: PhysicsGraph;
}

export const examples: ExampleDefinition[] = [
  // ── Core High-School Mechanics ──
  {
    id: "free-fall",
    title: "自由落体",
    prompt: "一个小球从高处自由下落，并与地面发生反弹。",
    graph: repairStableConstraintSpec(freeFall as unknown as PhysicsGraph)
  },
  {
    id: "spring-oscillator",
    title: "弹簧振子",
    prompt: "一个物块连接弹簧在水平面附近做振动。",
    graph: repairStableConstraintSpec(springOscillator as unknown as PhysicsGraph)
  },
  {
    id: "two-ball-perfect-elastic-collision",
    title: "两球弹性碰撞",
    prompt: "两个等质量小球在无重力水平线上发生正碰，恢复系数可调，动量和动能近似守恒。",
    graph: repairStableConstraintSpec(twoBallPerfectElasticCollision as unknown as PhysicsGraph)
  },
  {
    id: "inclined-plane-spring-profile",
    title: "斜面+弹簧+驱动力",
    prompt: "物块在斜面上连接弹簧，受时变驱动力作用，展示斜面、弹簧和运动曲线的组合。",
    graph: repairStableConstraintSpec(inclinedPlaneSpringProfile as unknown as PhysicsGraph)
  },
  {
    id: "hinge-pendulum",
    title: "铰链单摆",
    prompt: "摆球通过铰链连接到固定支点，在重力作用下摆动。",
    graph: repairStableConstraintSpec(hingePendulum as unknown as PhysicsGraph)
  },
  {
    id: "rope-pendulum",
    title: "绳约束单摆（可落后）",
    prompt: "摆球通过绳子悬挂，绳只拉不推：球在绳长范围内自由下落，绳拉直后自动转为摆动。",
    graph: repairStableConstraintSpec(ropePendulum as unknown as PhysicsGraph)
  },
  {
    id: "pulley-system",
    title: "滑轮系统（阿特伍德机）",
    prompt: "两个不同质量的物体通过滑轮连接，在重力作用下加速运动。",
    graph: repairStableConstraintSpec(pulleySystem as unknown as PhysicsGraph)
  },

  // ── Combined & Advanced ──
  {
    id: "charged-pendulum-fields",
    title: "电场+重力单摆",
    prompt: "一个带电小球作为单摆，同时受到重力场和水平电场作用。",
    graph: repairStableConstraintSpec(chargedPendulumFields as unknown as PhysicsGraph)
  },
  {
    id: "spring-collision-vertical",
    title: "竖直弹簧振子+碰撞",
    prompt: "竖直弹簧连接滑块A平衡静止，滑块B从A上方1m自由下落撞击A，弹性可调。",
    graph: repairStableConstraintSpec(springCollisionVertical as unknown as PhysicsGraph)
  },
  {
    id: "slider-damped",
    title: "滑轨阻尼",
    prompt: "滑块在水平滑轨上运动，带有线性阻尼逐渐减速。",
    graph: repairStableConstraintSpec(sliderDamped as unknown as PhysicsGraph)
  },
  {
    id: "cart-sticky-collision-inertia-friction",
    title: "摩擦：小车碰撞+惯性",
    prompt: "A车撞击B车并黏合，A车上C物块因惯性滑动受摩擦力，演示接触摩擦+碰撞耦合。",
    graph: repairStableConstraintSpec(cartStickyCollisionInertiaFriction as unknown as PhysicsGraph)
  },
  {
    id: "varying-field",
    title: "时变力场",
    prompt: "粒子受恒定重力与正弦时变垂直力场叠加，展示 field variation 时空变化。",
    graph: repairStableConstraintSpec(varyingField as unknown as PhysicsGraph)
  },
  {
    id: "em-gravity-charged-ball",
    title: "电磁重力复合场",
    prompt: "带电小球在重力场、水平匀强电场和垂直纸面匀强磁场的共同作用下运动。",
    graph: repairStableConstraintSpec(emGravityChargedBall as unknown as PhysicsGraph)
  },

  // ── Electric & Magnetic ──
  {
    id: "single-point-charge-field",
    title: "单点电荷电场",
    prompt: "固定正点电荷产生径向电场，带正电粒子以初速度进入，受库仑排斥力偏转。",
    graph: repairStableConstraintSpec(singlePointChargeField as unknown as PhysicsGraph)
  },
  {
    id: "two-moving-charges-coulomb",
    title: "移动点电荷库仑互作用",
    prompt: "两个自由正电荷通过 origin_from 动态绑定径向场，彼此库仑排斥改变轨迹。",
    graph: repairStableConstraintSpec(twoMovingChargesCoulomb as unknown as PhysicsGraph)
  },
  {
    id: "two-fixed-charges-dipole-field",
    title: "双点电荷偶极场",
    prompt: "两个固定异号点电荷（左正右负）产生偶极电场，试探粒子在合成场中运动。",
    graph: repairStableConstraintSpec(twoFixedChargesDipoleField as unknown as PhysicsGraph)
  },

  // ── Feature Demos ──
  {
    id: "spatial-variation-field",
    title: "空间变化力场",
    prompt: "多粒子在不同 x 位置受 |sin(2x)| 倍重力下落，观察空间分布差异。",
    graph: repairStableConstraintSpec(spatialVariationField as unknown as PhysicsGraph)
  },
  {
    id: "si-event-timed-rebound",
    title: "事件触发反弹",
    prompt: "小球自由下落，t=1.2s 事件设置速度，inferred_force 反解作用力。",
    graph: repairStableConstraintSpec(siEventTimedRebound as unknown as PhysicsGraph)
  },
  {
    id: "expression-driven-oscillator",
    title: "表达式驱动正弦轨迹",
    prompt: "粒子由 sin(t*2) 和 cos(t*1.3) 驱动 x,y 位置，形成李萨如图形。",
    graph: repairStableConstraintSpec(expressionDrivenOscillator as unknown as PhysicsGraph)
  },
  {
    id: "varying-field-with-event-impulse",
    title: "时变场+事件冲量",
    prompt: "粒子在重力+正弦场中运动，t=2s 平滑冲量，演示 temporal variation + impulse。",
    graph: repairStableConstraintSpec(varyingFieldWithEventImpulse as unknown as PhysicsGraph)
  },
];

export const defaultExample = examples[0];
