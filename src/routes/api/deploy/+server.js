import { json, error as server_error } from '@sveltejs/kit';
import supabase_admin from '$lib/supabase/admin'
import axios from 'axios'

export async function POST({ request, locals }) {

  const session = await locals.getSession()
  if (!session) {
    // the user is not signed in
    throw server_error(401, { message: 'Unauthorized' })
  }

  const {files, site_id, repo_name, create_new} = await request.json();
  const user_id = session.user.id

  // verify user is collaborator on site or server member
  const [ {data:collaborator}, {data:server_member} ] = await Promise.all([
    supabase_admin.from('collaborators').select('*').match({ site: site_id, user: user_id }).single(),
    supabase_admin.from('server_members').select('*').eq('user', user_id).single()
  ])

  if (collaborator || server_member) {
    const {data:token} = await supabase_admin.from('config').select('value').single()

    if (!token) {
      return json({deployment: null, error: 'No token found' });
    }

    if (create_new) {
      await create_repo({ repo_name, token: token.value })
    }

    // TODO: ensure existing repo matches newer repo, or create repo if none exists and user is repo owner
    const new_deployment = await push_site_to_github({ files, token: token.value, repo_name })

    await supabase_admin.from('sites').update({ active_deployment: new_deployment}).eq('id', site_id)

    return json({ deployment: new_deployment, error: null });
  } else {
    console.log({collaborator, server_member})
    return json({ deployment: null, error: 'Unauthorized' });
  }

}

async function create_repo({ repo_name, token }) {
  const { data } = await axios.post(
    `https://api.github.com/user/repos`,
    {
      name: repo_name,
      auto_init: true
    },
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return data
}

async function push_site_to_github({ files, token, repo_name }) {

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
  }

  const [{data:existing_repo}, {data: [latest_commit]}] = await Promise.all([
    axios.get(`https://api.github.com/repos/${repo_name}`, { headers }),
    axios.get(`https://api.github.com/repos/${repo_name}/commits?sha=main`, { headers })
  ])
  const activeSha = latest_commit?.sha

  const tree = await createTree()
  const commit = await createCommit(tree.sha)
  const final = await pushCommit(commit.sha)

  return {
    deploy_id: final.object.sha,
    repo: existing_repo,
    created: Date.now(),
  }

  async function createTree() {
    const bundle = files.map((file) => ({
      path: file.file,
      content: file.data,
      type: 'blob',
      mode: '100644',
    }))
    const { data } = await axios.post(
      `https://api.github.com/repos/${repo_name}/git/trees`,
      {
        tree: bundle,
      },
      { headers }
    )
    return data
  }

  async function createCommit(tree) {
    const { data } = await axios.post(
      `https://api.github.com/repos/${repo_name}/git/commits`,
      {
        message: 'Update site',
        tree,
        ...(activeSha ? { parents: [activeSha] } : {}),
      },
      { headers }
    )
    return data
  }

  async function pushCommit(commitSha) {
    const { data } = await axios.patch(
      `https://api.github.com/repos/${repo_name}/git/refs/heads/main`,
      {
        sha: commitSha,
        force: true,
      },
      { headers }
    )
    return data
  }
}