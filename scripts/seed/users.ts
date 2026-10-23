// Local development users. LOCAL ONLY: these accounts exist only in the local Supabase started by
// `npx supabase start`. Never use this seed against a hosted project.
export const LOCAL_TEST_PASSWORD = "local-dev-only-Freshroots-1";
export const LOCAL_USERS = [
  { id: "00000000-0000-4000-a000-000000000001", email: "priya@freshroots.test", name: "Priya Sharma", roles: ["uploader"], owner: false },
  { id: "00000000-0000-4000-a000-000000000002", email: "raghav@freshroots.test", name: "Raghav Kulkarni", roles: ["planner"], owner: false },
  { id: "00000000-0000-4000-a000-000000000003", email: "procurement@freshroots.test", name: "Procurement head", roles: ["procurement"], owner: false },
  { id: "00000000-0000-4000-a000-000000000004", email: "it.admin@freshroots.test", name: "IT admin", roles: ["admin", "uploader"], owner: false },
  { id: "00000000-0000-4000-a000-000000000005", email: "deepa@freshroots.test", name: "Deepa Nair", roles: ["planner", "admin"], owner: true },
  { id: "00000000-0000-4000-a000-000000000006", email: "ceo@freshroots.test", name: "CEO", roles: ["viewer"], owner: false },
];
