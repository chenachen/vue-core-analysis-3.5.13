import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { arrayInstrumentations } from './arrayInstrumentations'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import { ITERATE_KEY, track, trigger } from './dep'
import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*@__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

// 获取内置的Symbol
const builtInSymbols = new Set(
  /*@__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => Symbol[key as keyof SymbolConstructor])
    .filter(isSymbol),
)

function hasOwnProperty(this: object, key: unknown) {
  // #10455 hasOwnProperty may be called with non-string values
  if (!isSymbol(key)) key = String(key)
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key as string)
}

class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false,
    protected readonly _isShallow = false,
  ) {}

  get(target: Target, key: string | symbol, receiver: object): any {
    if (key === ReactiveFlags.SKIP) return target[ReactiveFlags.SKIP]

    const isReadonly = this._isReadonly,
      isShallow = this._isShallow
    // 返回特定值
    if (key === ReactiveFlags.IS_REACTIVE) {
      // 是否响应式对象
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      // 是否只读
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      // 是否浅层监听对象
      return isShallow
    } else if (key === ReactiveFlags.RAW) {
      if (
        receiver ===
          (isReadonly
            ? isShallow
              ? shallowReadonlyMap
              : readonlyMap
            : isShallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        // receiver is not the reactive proxy, but has the same prototype
        // this means the receiver is a user proxy of the reactive proxy
        // 如果receiver和target有着相同的原型链，同样返回target
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        // 返回源对象
        return target
      }
      // early return undefined
      return
    }

    // 判断是否数组
    const targetIsArray = isArray(target)

    if (!isReadonly) {
      let fn: Function | undefined
      // 判断是否数组的原生方法
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn
      }
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    // 获取值
    const res = Reflect.get(
      target,
      key,
      // if this is a proxy wrapping a ref, return methods using the raw ref
      // as receiver so that we don't have to call `toRaw` on the ref in all
      // its class methods
      // 这个判断是针对reactive(ref(obj))这种情况的，这种情况下如果不做以下判断，在RefImpl和ComputedRefImpl中的this指向的是代理对象，而不是ref本身
      // 会导致在RefImpl和ComputedRefImpl内部get value()方法中需要通过toRaw方法获取到原始对象
      // 改动的commit在这https://github.com/vuejs/core/pull/10397/commits/1318017d111ded1977daed0db4e301f676a78628
      isRef(target) ? target : receiver,
    )

    // 先判断是否Symbol，如果是的话判断是否Symbol对象自有属性方法，如果否的话判断是否不追踪的key值
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 依赖追踪
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 浅层监听直接返回
    if (isShallow) {
      return res
    }

    if (isRef(res)) {
      // 如果是ref，则解包
      // ref unwrapping - 跳过 Array + integer 键的 解包。
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    // 如果值依然是对象，则继续深度追踪或者深度只读
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(false, isShallow)
  }

  set(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    // 先记录旧的值
    let oldValue = target[key]
    if (!this._isShallow) {
      // 判断是不是只读
      const isOldValueReadonly = isReadonly(oldValue)
      if (!isShallow(value) && !isReadonly(value)) {
        // 新的值和旧的值都获取源对象
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      // 判断旧值值是否是ref且新值不是ref，如果不是只读，那么对ref进行赋值，而不是直接替换
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          return false
        } else {
          oldValue.value = value
          return true
        }
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    // 判断是否已经有这个key值，用于判定是新增还是修改
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(
      target,
      key,
      value,
      // 这个判断是针对reactive(ref(obj))这种情况的，这种情况下如果不做以下判断，在RefImpl和ComputedRefImpl中的this指向的是代理对象，而不是ref本身
      // 会导致在RefImpl和ComputedRefImpl内部get value()方法中需要通过toRaw方法获取到原始对象
      // 改动的commit在这https://github.com/vuejs/core/pull/10397/commits/1318017d111ded1977daed0db4e301f676a78628
      isRef(target) ? target : receiver,
    )
    // don't trigger if target is something up in the prototype chain of original
    // 如果是修改原型链上的某些值则不触发
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  deleteProperty(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
  ): boolean {
    // 判断是否有这个值
    const hadKey = hasOwn(target, key)
    // 获取旧值
    const oldValue = target[key]
    // 获取删除结果
    const result = Reflect.deleteProperty(target, key)
    // 如果有值并且删除成功则触发
    if (result && hadKey) {
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }

  has(target: Record<string | symbol, unknown>, key: string | symbol): boolean {
    const result = Reflect.has(target, key)
    // 不是symbol或者不是Symbol对象的静态方法属性则触发追踪
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }

  ownKeys(target: Record<string | symbol, unknown>): (string | symbol)[] {
    // 直接触发追踪
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY,
    )
    return Reflect.ownKeys(target)
  }
}

// readonly不对修改操作生效，并且也不会触发trigger函数
class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(true, isShallow)
  }

  set(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

export const mutableHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new MutableReactiveHandler()

export const readonlyHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new ReadonlyReactiveHandler()

export const shallowReactiveHandlers: MutableReactiveHandler =
  /*@__PURE__*/ new MutableReactiveHandler(true)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers: ReadonlyReactiveHandler =
  /*@__PURE__*/ new ReadonlyReactiveHandler(true)
