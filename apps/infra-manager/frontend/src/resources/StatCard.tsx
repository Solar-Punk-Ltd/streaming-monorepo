import { Paper, Typography } from '@mui/material';

export function StatCard({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub?: string;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="overline" sx={{
        color: "text.secondary"
      }}>
        {title}
      </Typography>
      <Typography variant="h5">{value}</Typography>
      {sub && (
        <Typography variant="caption" sx={{
          color: "text.secondary"
        }}>
          {sub}
        </Typography>
      )}
    </Paper>
  );
}
