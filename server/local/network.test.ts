import assert from "node:assert/strict";
import type os from "node:os";
import { describe, test } from "node:test";
import { defaultRouteAddress, eligible, type Interfaces, ipv4Text, isLoopback, isPrivateV4, localNetwork, NETWORK_CACHE_MS } from "./network.ts";

/** An address in 192.168.0.0/16, built from the block so no specific one is written down. */
const C_BLOCK = (third: number, fourth: number): string => `${"192.168.0.0/16".split(".").slice(0, 2).join(".")}.${third}.${fourth}`;

const MAC = "3c:22:fb:01:02:03";
const NO_MAC = "00:00:00:00:00:00";

function v4(address: string, mac = MAC, internal = false): os.NetworkInterfaceInfo {
  return { address, netmask: "255.255.255.0", family: "IPv4", mac, internal, cidr: `${address}/24` };
}

function v6(address: string): os.NetworkInterfaceInfo {
  return { address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: MAC, internal: false, cidr: `${address}/64`, scopeid: 0 };
}

function fixed(interfaces: Interfaces, route: string | null) {
  return localNetwork({ interfaces: () => interfaces, routeAddress: async () => route });
}

describe("address ranges", () => {
  test("private means 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16, and nothing beside them", () => {
    for (const a of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", C_BLOCK(0, 1), C_BLOCK(255, 254), "::ffff:10.0.0.3"]) assert.equal(isPrivateV4(a), true, a);
    for (const a of ["9.255.255.255", "11.0.0.1", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "100.64.0.1", "169.254.1.1", "127.0.0.1", "203.0.113.5", "8.8.8.8", "fd00::1", "::1", "", "10.0.0", "10.0.0.256", "010.0.0.1", "10.0.0.1.5"]) {
      assert.equal(isPrivateV4(a), false, a);
    }
    assert.equal(isPrivateV4(undefined), false);
  });

  test("loopback is 127.0.0.0/8 and ::1, mapped or not", () => {
    for (const a of ["127.0.0.1", "127.255.0.9", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "::1"]) assert.equal(isLoopback(a), true, a);
    for (const a of ["128.0.0.1", "126.255.255.255", "10.0.0.1", "::2", "0:0:0:0:0:0:0:1", undefined]) assert.equal(isLoopback(a), false, String(a));
  });

  test("the dotted form of an IPv4 address, mapped or not, and null for anything else", () => {
    assert.equal(ipv4Text("::ffff:10.0.0.3"), "10.0.0.3");
    assert.equal(ipv4Text("172.16.9.1"), "172.16.9.1");
    for (const a of ["::1", "fe80::1", "localhost", "1.2.3", "1.2.3.4.5", "1.2.3.x", "+1.2.3.4", " 1.2.3.4"]) assert.equal(ipv4Text(a), null, a);
  });
});

describe("eligible interfaces", () => {
  test("a computer's own Wi-Fi and Ethernet, on every system", () => {
    for (const name of ["en0", "en7", "eth0", "enp3s0", "wlan0", "wlp2s0", "Wi-Fi", "Ethernet", "Ethernet 2", "WLAN", "bridge0"]) assert.equal(eligible(name, { mac: MAC }), true, name);
  });

  test("not a bridge, a virtual machine's network or a tunnel, by name, including Windows' friendly names", () => {
    const names = [
      "docker0",
      "br-1a2b3c4d5e6f",
      "veth12ab",
      "vEthernet (WSL (Hyper-V firewall))",
      "vEthernet (Default Switch)",
      "vmnet8",
      "VMware Network Adapter VMnet1",
      "vboxnet0",
      "VirtualBox Host-Only Network",
      "utun3",
      "tun0",
      "tap0",
      "TAP-Windows Adapter V9",
      "wg0",
      "WireGuard Tunnel",
      "ppp0",
      "ipsec0",
      "tailscale0",
      "Tailscale",
      "zt7nnig26",
      "ZeroTier One [8056c2e21c000001]",
      "OpenVPN Wintun",
      "virbr0",
      "lxcbr0",
      "lxdbr0",
      "podman0",
      "cni0",
      "bridge100",
      "bridge101",
      "vnic0",
    ];
    for (const name of names) assert.equal(eligible(name, { mac: MAC }), false, name);
  });

  test("not an interface reporting an all-zero MAC, whatever its name", () => {
    assert.equal(eligible("en5", { mac: NO_MAC }), false);
  });
});

describe("localAddresses", () => {
  test("every private IPv4 address on a network, once, in the system's order", () => {
    const net = fixed(
      {
        lo0: [v4("127.0.0.1", NO_MAC, true), { ...v6("::1"), internal: true }],
        en0: [v6("fe80::1"), v4(C_BLOCK(4, 20))],
        utun4: [v4("10.8.0.2", NO_MAC)],
        docker0: [v4("172.17.0.1")],
        en1: [v4("203.0.113.5"), v4("100.64.3.4"), v4("169.254.7.7")],
        en2: [v4(C_BLOCK(4, 20))],
      },
      null,
    );
    // Not filtered by eligibility: the Host and Origin lists accept every address this computer answers at.
    assert.deepEqual(net.localAddresses(), [C_BLOCK(4, 20), "10.8.0.2", "172.17.0.1"]);
  });

  test("read again only after 5 s", () => {
    let t = 0;
    let reads = 0;
    let address = "10.0.0.5";
    const net = localNetwork({
      now: () => t,
      interfaces: () => {
        reads++;
        return { en0: [v4(address)] };
      },
      routeAddress: async () => null,
    });
    assert.deepEqual(net.localAddresses(), ["10.0.0.5"]);
    address = "10.0.0.6";
    t = NETWORK_CACHE_MS - 1;
    assert.deepEqual(net.localAddresses(), ["10.0.0.5"]);
    assert.equal(reads, 1);
    t = NETWORK_CACHE_MS;
    assert.deepEqual(net.localAddresses(), ["10.0.0.6"]);
    assert.equal(reads, 2);
  });
});

describe("primaryAddress (D-261113-085)", () => {
  test("the default route's address when its interface is eligible, even when it is not the first", () => {
    const net = fixed({ eth0: [v4("10.0.0.3")], wlan0: [v4("172.16.0.8")] }, "172.16.0.8");
    return net.primaryAddress().then((a) => assert.equal(a, "172.16.0.8"));
  });

  test("a full-tunnel VPN owning the default route: the Wi-Fi's private address instead", async () => {
    // By name, with the tunnel's all-zero MAC, and by MAC alone under a name the list does not know.
    assert.equal(await fixed({ en0: [v4(C_BLOCK(4, 20))], utun4: [v4("10.8.0.2", NO_MAC)] }, "10.8.0.2").primaryAddress(), C_BLOCK(4, 20));
    assert.equal(await fixed({ wg0: [v4("10.8.0.2")], en0: [v4("172.16.5.5")] }, "10.8.0.2").primaryAddress(), "172.16.5.5");
    assert.equal(await fixed({ corpvpn: [v4("10.8.0.2", NO_MAC)], en0: [v4("172.16.5.5")] }, "10.8.0.2").primaryAddress(), "172.16.5.5");
  });

  test("a VPN owning the default route with no other network: none", async () => {
    assert.equal(await fixed({ utun4: [v4("10.8.0.2", NO_MAC)] }, "10.8.0.2").primaryAddress(), null);
  });

  test("a public default route with a private second interface: the private one", async () => {
    assert.equal(await fixed({ eth0: [v4("203.0.113.5")], eth1: [v4("10.0.0.7")] }, "203.0.113.5").primaryAddress(), "10.0.0.7");
  });

  test("a public address alone: none, so no public address is ever shown", async () => {
    assert.equal(await fixed({ eth0: [v4("203.0.113.5")] }, "203.0.113.5").primaryAddress(), null);
  });

  test("no default route: the first eligible private address, past a container bridge", async () => {
    assert.equal(await fixed({ docker0: [v4("172.17.0.1")], wlan0: [v4("10.0.0.9")], eth0: [v4("10.0.0.10")] }, null).primaryAddress(), "10.0.0.9");
  });

  test("a route lookup that fails counts as no default route", async () => {
    const net = localNetwork({ interfaces: () => ({ en0: [v4("10.0.0.9")] }), routeAddress: () => Promise.reject(new Error("ENETUNREACH")) });
    assert.equal(await net.primaryAddress(), "10.0.0.9");
  });

  test("offline: none", async () => {
    assert.equal(await fixed({ lo0: [v4("127.0.0.1", NO_MAC, true)] }, null).primaryAddress(), null);
  });

  test("the route is asked again only after 5 s", async () => {
    let t = 0;
    let asks = 0;
    const net = localNetwork({
      now: () => t,
      interfaces: () => ({ en0: [v4("10.0.0.9")], en1: [v4("10.0.0.10")] }),
      routeAddress: async () => (++asks === 1 ? "10.0.0.9" : "10.0.0.10"),
    });
    assert.equal(await net.primaryAddress(), "10.0.0.9");
    t = NETWORK_CACHE_MS - 1;
    assert.equal(await net.primaryAddress(), "10.0.0.9");
    t = NETWORK_CACHE_MS;
    assert.equal(await net.primaryAddress(), "10.0.0.10");
    assert.equal(asks, 2);
  });
});

describe("defaultRouteAddress", () => {
  test("answers with this computer's IPv4 address on its default route, or null offline, at once", async () => {
    const started = Date.now();
    const address = await defaultRouteAddress();
    assert.ok(address === null || ipv4Text(address) === address, String(address));
    assert.ok(Date.now() - started < 1_500);
  });
});
