import systeminformation from 'systeminformation';
import { size } from './misc';

const cache = {
    mid: '', cpu: '', osinfo: '', flags: '',
};

export async function get() {
    const [Cpu, Memory, OsInfo, CurrentLoad, CpuFlags, CpuTemp, Battery] = await Promise.all([
        systeminformation.cpu(),
        systeminformation.mem(),
        systeminformation.osInfo(),
        systeminformation.currentLoad(),
        systeminformation.cpuFlags(),
        systeminformation.cpuTemperature(),
        systeminformation.battery(),
    ]);
    const cpu = `${Cpu.manufacturer} ${Cpu.brand}`;
    const memory = `${size(Memory.active)}/${size(Memory.total)}`;
    const osinfo = `${OsInfo.distro} ${OsInfo.release} ${OsInfo.codename} ${OsInfo.kernel} ${OsInfo.arch}`;
    const load = `${CurrentLoad.avgload}`;
    const flags = CpuFlags;
    let battery;
    if (!Battery.hasbattery) battery = 'No battery';
    else battery = `${Battery.type} ${Battery.model} ${Battery.percent}%${Battery.ischarging ? ' Charging' : ''}`;
    const mid = OsInfo.serial;
    cache.cpu = cpu;
    cache.osinfo = osinfo;
    cache.flags = flags;
    cache.mid = mid;
    return {
        mid, cpu, memory, osinfo, load, flags, CpuTemp, battery,
    };
}

export async function update(): Promise<[string, any, any]> {
    const [Memory, CurrentLoad, CpuTemp, Battery] = await Promise.all([
        systeminformation.mem(),
        systeminformation.currentLoad(),
        systeminformation.cpuTemperature(),
        systeminformation.battery(),
    ]);
    const {
        mid, cpu, osinfo, flags,
    } = cache;
    const memory = `${size(Memory.active)}/${size(Memory.total)}`;
    const load = `${CurrentLoad.avgload}`;
    let battery;
    if (!Battery.hasbattery) battery = 'No battery';
    else battery = `${Battery.type} ${Battery.model} ${Battery.percent}%${Battery.ischarging ? ' Charging' : ''}`;
    return [
        mid,
        {
            memory, load, battery, CpuTemp,
        },
        {
            mid, cpu, memory, osinfo, load, flags, battery, CpuTemp,
        },
    ];
}

global.Hydro.lib.sysinfo = { get, update };
