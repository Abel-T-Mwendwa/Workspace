import { client } from "../core/supabase-client.js";

export async function fetchProfiles() {
  const { data, error } = await client.from("profiles").select("id,username,full_name,role,active,production_access,dispatch_access,route_admin_access,production_store_access,rider_request_access,created_at").order("full_name");
  if (error) throw error;
  return data || [];
}
