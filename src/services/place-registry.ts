/**
 * 兼容旧接口的内部递增收录号注册表；公开地点编号使用坐标 placeId。
 *
 * 产品以地点为一等公民：凡是被平台收录的地点（样例目录、社区审核通过）
 * 都获得一个全局唯一、终身不变的递增编号；地点从目录移除后编号退役，不再复用。
 * 编号在首次收录时分配并随状态持久化，重启后保持稳定。
 */
export class PlaceNumberRegistry {
  private counter = 0;
  private numbers = new Map<string, number>();
  serialize() { return JSON.stringify({ counter: this.counter, numbers: [...this.numbers.entries()] }); }
  loadSerialized(value: string) {
    const data = JSON.parse(value);
    this.counter = Number(data.counter) || 0;
    this.numbers = new Map(Array.isArray(data.numbers) ? data.numbers : []);
  }
  ensure(placeId: string): number {
    const existing = this.numbers.get(placeId);
    if (existing) return existing;
    this.counter += 1;
    this.numbers.set(placeId, this.counter);
    return this.counter;
  }
  numberOf(placeId: string): number | undefined {
    return this.numbers.get(placeId);
  }
}
